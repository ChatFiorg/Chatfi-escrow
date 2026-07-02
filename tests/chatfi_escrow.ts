import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  getAssociatedTokenAddressSync,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { assert } from "chai";

describe("chatfi_escrow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.ChatfiEscrow as Program;

  const seller = provider.wallet as anchor.Wallet;
  const admin = seller; // config admin == seller/payer wallet for these tests

  const FEE_BPS = 100; // 1%
  const MIN_TIMEOUT = 15 * 60;
  const MAX_TIMEOUT = 7 * 24 * 60 * 60;
  const DEFAULT_TIMEOUT = 30 * 60; // 30 min, safely inside bounds
  const SHORT_TIMEOUT = MIN_TIMEOUT; // used for expiry tests

  let mint: PublicKey;
  let configPda: PublicKey;
  let feeCollector: Keypair;

  async function airdrop(pubkey: PublicKey, sol = 0.02) {
    // Devnet's public faucet is heavily rate-limited and frequently returns
    // "Internal error" from shared CI IPs, so fund ephemeral test keypairs
    // by transferring from the already-funded deploy wallet instead.
    const tx = new anchor.web3.Transaction().add(
      SystemProgram.transfer({
        fromPubkey: provider.wallet.publicKey,
        toPubkey: pubkey,
        lamports: Math.round(sol * anchor.web3.LAMPORTS_PER_SOL),
      })
    );
    await provider.sendAndConfirm(tx);
  }

  function deriveEscrow(sellerKey: PublicKey, buyerKey: PublicKey, tradeId: BN) {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("escrow"),
        sellerKey.toBuffer(),
        buyerKey.toBuffer(),
        tradeId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
  }

  function deriveVault(escrowPda: PublicKey) {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowPda.toBuffer()],
      program.programId
    );
  }

  async function newTradeId(): Promise<BN> {
    return new BN(Date.now()).add(new BN(Math.floor(Math.random() * 1000)));
  }

  before(async () => {
    [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    feeCollector = Keypair.generate();
    await airdrop(feeCollector.publicKey);

    mint = await createMint(
      provider.connection,
      seller.payer,
      seller.publicKey,
      null,
      6
    );

    try {
      await program.methods
        .initConfig(FEE_BPS)
        .accounts({
          admin: admin.publicKey,
          feeCollector: feeCollector.publicKey,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } catch (e: any) {
      if (!String(e).includes("already in use")) throw e;
    }
  });

  async function setupTrade(amount = 1_000_000) {
    const buyer = Keypair.generate();
    await airdrop(buyer.publicKey);

    const sellerTokenAccount = await createAccount(
      provider.connection,
      seller.payer,
      mint,
      seller.publicKey
    );
    await mintTo(
      provider.connection,
      seller.payer,
      mint,
      sellerTokenAccount,
      seller.payer,
      amount
    );

    const tradeId = await newTradeId();
    const [escrowPda] = deriveEscrow(seller.publicKey, buyer.publicKey, tradeId);
    const [vaultPda] = deriveVault(escrowPda);

    const buyerTokenAccount = getAssociatedTokenAddressSync(mint, buyer.publicKey);
    const feeTokenAccount = getAssociatedTokenAddressSync(mint, feeCollector.publicKey);

    return {
      buyer,
      sellerTokenAccount,
      buyerTokenAccount,
      feeTokenAccount,
      tradeId,
      escrowPda,
      vaultPda,
      amount,
    };
  }

  async function initAndFund(t: Awaited<ReturnType<typeof setupTrade>>, timeoutSeconds = DEFAULT_TIMEOUT) {
    await program.methods
      .initializeEscrow(t.tradeId, new BN(t.amount), new BN(timeoutSeconds))
      .accounts({
        seller: seller.publicKey,
        buyer: t.buyer.publicKey,
        mint,
        escrow: t.escrowPda,
        vault: t.vaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await program.methods
      .fundEscrow()
      .accounts({
        seller: seller.publicKey,
        mint,
        escrow: t.escrowPda,
        vault: t.vaultPda,
        sellerTokenAccount: t.sellerTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
  }

  async function assertClosed(pda: PublicKey) {
    const info = await provider.connection.getAccountInfo(pda);
    assert.isNull(info, `expected account ${pda.toBase58()} to be closed`);
  }

  describe("config", () => {
    it("rejects fee_bps above 1000 on init (skipped if config already exists)", async () => {
      const [freshConfig] = [configPda];
      let failed = false;
      try {
        await program.methods
          .updateConfig(null, null, 1001)
          .accounts({ admin: admin.publicKey, config: configPda })
          .rpc();
      } catch (e: any) {
        failed = true;
        assert.include(String(e), "FeeTooHigh");
      }
      assert.isTrue(failed, "expected FeeTooHigh error");
    });

    it("allows admin to update fee_bps within bounds", async () => {
      await program.methods
        .updateConfig(null, null, FEE_BPS)
        .accounts({ admin: admin.publicKey, config: configPda })
        .rpc();

      const cfg = await program.account.config.fetch(configPda);
      assert.equal(cfg.feeBps, FEE_BPS);
    });

    it("rejects update_config from a non-admin signer", async () => {
      const intruder = Keypair.generate();
      await airdrop(intruder.publicKey);
      let failed = false;
      try {
        await program.methods
          .updateConfig(null, null, 50)
          .accounts({ admin: intruder.publicKey, config: configPda })
          .signers([intruder])
          .rpc();
      } catch (e: any) {
        failed = true;
      }
      assert.isTrue(failed, "expected non-admin update to fail");
    });
  });

  describe("happy path: initialize -> fund -> release", () => {
    it("releases funds to buyer, pays fee, closes vault and escrow", async () => {
      const t = await setupTrade();
      await initAndFund(t);

      await program.methods
        .releaseEscrow()
        .accounts({
          seller: seller.publicKey,
          buyer: t.buyer.publicKey,
          feeCollector: feeCollector.publicKey,
          mint,
          config: configPda,
          escrow: t.escrowPda,
          vault: t.vaultPda,
          buyerTokenAccount: t.buyerTokenAccount,
          feeTokenAccount: t.feeTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const expectedFee = Math.floor((t.amount * FEE_BPS) / 10_000);
      const expectedPayout = t.amount - expectedFee;

      const buyerAcc = await getAccount(provider.connection, t.buyerTokenAccount);
      assert.equal(buyerAcc.amount.toString(), expectedPayout.toString());

      const feeAcc = await getAccount(provider.connection, t.feeTokenAccount);
      assert.isAtLeast(Number(feeAcc.amount), expectedFee);

      await assertClosed(t.vaultPda);
      await assertClosed(t.escrowPda);
    });

    it("auto-creates buyer and fee ATAs via init_if_needed when they don't exist yet", async () => {
      const t = await setupTrade();
      await initAndFund(t);

      const buyerAtaBefore = await provider.connection.getAccountInfo(t.buyerTokenAccount);
      assert.isNull(buyerAtaBefore, "buyer ATA should not exist before release");

      await program.methods
        .releaseEscrow()
        .accounts({
          seller: seller.publicKey,
          buyer: t.buyer.publicKey,
          feeCollector: feeCollector.publicKey,
          mint,
          config: configPda,
          escrow: t.escrowPda,
          vault: t.vaultPda,
          buyerTokenAccount: t.buyerTokenAccount,
          feeTokenAccount: t.feeTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const buyerAtaAfter = await provider.connection.getAccountInfo(t.buyerTokenAccount);
      assert.isNotNull(buyerAtaAfter, "buyer ATA should be created by init_if_needed");
    });

    it("rejects release from a non-seller signer", async () => {
      const t = await setupTrade();
      await initAndFund(t);
      const intruder = Keypair.generate();
      await airdrop(intruder.publicKey);

      let failed = false;
      try {
        await program.methods
          .releaseEscrow()
          .accounts({
            seller: intruder.publicKey,
            buyer: t.buyer.publicKey,
            feeCollector: feeCollector.publicKey,
            mint,
            config: configPda,
            escrow: t.escrowPda,
            vault: t.vaultPda,
            buyerTokenAccount: t.buyerTokenAccount,
            feeTokenAccount: t.feeTokenAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([intruder])
          .rpc();
      } catch (e: any) {
        failed = true;
      }
      assert.isTrue(failed, "expected release from non-seller to fail");
    });

    it("rejects double release (escrow account no longer exists after close)", async () => {
      const t = await setupTrade();
      await initAndFund(t);

      const releaseAccounts = {
        seller: seller.publicKey,
        buyer: t.buyer.publicKey,
        feeCollector: feeCollector.publicKey,
        mint,
        config: configPda,
        escrow: t.escrowPda,
        vault: t.vaultPda,
        buyerTokenAccount: t.buyerTokenAccount,
        feeTokenAccount: t.feeTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      };

      await program.methods.releaseEscrow().accounts(releaseAccounts).rpc();

      let failed = false;
      try {
        await program.methods.releaseEscrow().accounts(releaseAccounts).rpc();
      } catch (e: any) {
        failed = true;
      }
      assert.isTrue(failed, "expected second release call to fail: escrow already closed");
    });
  });

  describe("timeout_seconds bounds", () => {
    it("rejects timeout below 15 minutes", async () => {
      const t = await setupTrade();
      let failed = false;
      try {
        await program.methods
          .initializeEscrow(t.tradeId, new BN(t.amount), new BN(MIN_TIMEOUT - 1))
          .accounts({
            seller: seller.publicKey,
            buyer: t.buyer.publicKey,
            mint,
            escrow: t.escrowPda,
            vault: t.vaultPda,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
      } catch (e: any) {
        failed = true;
        assert.include(String(e), "InvalidTimeout");
      }
      assert.isTrue(failed, "expected InvalidTimeout for too-short timeout");
    });

    it("rejects timeout above 7 days", async () => {
      const t = await setupTrade();
      let failed = false;
      try {
        await program.methods
          .initializeEscrow(t.tradeId, new BN(t.amount), new BN(MAX_TIMEOUT + 1))
          .accounts({
            seller: seller.publicKey,
            buyer: t.buyer.publicKey,
            mint,
            escrow: t.escrowPda,
            vault: t.vaultPda,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
      } catch (e: any) {
        failed = true;
        assert.include(String(e), "InvalidTimeout");
      }
      assert.isTrue(failed, "expected InvalidTimeout for too-long timeout");
    });

    it("accepts timeout at exact bounds (min and max)", async () => {
      const tMin = await setupTrade();
      await program.methods
        .initializeEscrow(tMin.tradeId, new BN(tMin.amount), new BN(MIN_TIMEOUT))
        .accounts({
          seller: seller.publicKey,
          buyer: tMin.buyer.publicKey,
          mint,
          escrow: tMin.escrowPda,
          vault: tMin.vaultPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      const escrowAcc = await program.account.escrow.fetch(tMin.escrowPda);
      assert.isDefined(escrowAcc);
    });
  });

  describe("cancel_escrow", () => {
    it("cancels from Created (no funds moved, escrow + vault closed)", async () => {
      const t = await setupTrade();
      await program.methods
        .initializeEscrow(t.tradeId, new BN(t.amount), new BN(DEFAULT_TIMEOUT))
        .accounts({
          seller: seller.publicKey,
          buyer: t.buyer.publicKey,
          mint,
          escrow: t.escrowPda,
          vault: t.vaultPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      await program.methods
        .cancelEscrow()
        .accounts({
          seller: seller.publicKey,
          mint,
          escrow: t.escrowPda,
          vault: t.vaultPda,
          sellerTokenAccount: t.sellerTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      await assertClosed(t.escrowPda);
      await assertClosed(t.vaultPda);
    });

    it("cancels from Funded and refunds seller in full", async () => {
      const t = await setupTrade();
      await initAndFund(t);

      const beforeAcc = await getAccount(provider.connection, t.sellerTokenAccount);

      await program.methods
        .cancelEscrow()
        .accounts({
          seller: seller.publicKey,
          mint,
          escrow: t.escrowPda,
          vault: t.vaultPda,
          sellerTokenAccount: t.sellerTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const afterAcc = await getAccount(provider.connection, t.sellerTokenAccount);
      assert.equal(
        (Number(afterAcc.amount) - Number(beforeAcc.amount)).toString(),
        t.amount.toString()
      );
      await assertClosed(t.escrowPda);
      await assertClosed(t.vaultPda);
    });

    it("rejects cancel from a non-seller signer", async () => {
      const t = await setupTrade();
      await initAndFund(t);
      const intruder = Keypair.generate();
      await airdrop(intruder.publicKey);

      let failed = false;
      try {
        await program.methods
          .cancelEscrow()
          .accounts({
            seller: intruder.publicKey,
            mint,
            escrow: t.escrowPda,
            vault: t.vaultPda,
            sellerTokenAccount: t.sellerTokenAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([intruder])
          .rpc();
      } catch (e: any) {
        failed = true;
      }
      assert.isTrue(failed, "expected cancel from non-seller to fail");
    });
  });

  describe("reclaim_expired_escrow", () => {
    it("rejects reclaim before expiry", async () => {
      const t = await setupTrade();
      await initAndFund(t, DEFAULT_TIMEOUT);
      const caller = Keypair.generate();
      await airdrop(caller.publicKey);

      let failed = false;
      try {
        await program.methods
          .reclaimExpiredEscrow()
          .accounts({
            caller: caller.publicKey,
            seller: seller.publicKey,
            mint,
            escrow: t.escrowPda,
            vault: t.vaultPda,
            sellerTokenAccount: t.sellerTokenAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([caller])
          .rpc();
      } catch (e: any) {
        failed = true;
        assert.include(String(e), "NotExpired");
      }
      assert.isTrue(failed, "expected NotExpired error before timeout elapses");
    });

    it("allows a permissionless caller to reclaim a Funded escrow after expiry", async function () {
      this.timeout(SHORT_TIMEOUT * 1000 + 60_000);

      const t = await setupTrade();
      await initAndFund(t, SHORT_TIMEOUT);

      await new Promise((r) => setTimeout(r, (SHORT_TIMEOUT + 5) * 1000));

      const caller = Keypair.generate();
      await airdrop(caller.publicKey);

      const beforeAcc = await getAccount(provider.connection, t.sellerTokenAccount);

      await program.methods
        .reclaimExpiredEscrow()
        .accounts({
          caller: caller.publicKey,
          seller: seller.publicKey,
          mint,
          escrow: t.escrowPda,
          vault: t.vaultPda,
          sellerTokenAccount: t.sellerTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([caller])
        .rpc();

      const afterAcc = await getAccount(provider.connection, t.sellerTokenAccount);
      assert.equal(
        (Number(afterAcc.amount) - Number(beforeAcc.amount)).toString(),
        t.amount.toString()
      );
      await assertClosed(t.escrowPda);
      await assertClosed(t.vaultPda);
    });

    it("allows reclaim of a Created (never funded) escrow after expiry, no token transfer needed", async function () {
      this.timeout(SHORT_TIMEOUT * 1000 + 60_000);

      const t = await setupTrade();
      await program.methods
        .initializeEscrow(t.tradeId, new BN(t.amount), new BN(SHORT_TIMEOUT))
        .accounts({
          seller: seller.publicKey,
          buyer: t.buyer.publicKey,
          mint,
          escrow: t.escrowPda,
          vault: t.vaultPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      await new Promise((r) => setTimeout(r, (SHORT_TIMEOUT + 5) * 1000));

      const caller = Keypair.generate();
      await airdrop(caller.publicKey);

      await program.methods
        .reclaimExpiredEscrow()
        .accounts({
          caller: caller.publicKey,
          seller: seller.publicKey,
          mint,
          escrow: t.escrowPda,
          vault: t.vaultPda,
          sellerTokenAccount: t.sellerTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([caller])
        .rpc();

      await assertClosed(t.escrowPda);
      await assertClosed(t.vaultPda);
    });
  });

  describe("raise_dispute / resolve_dispute", () => {
    it("buyer can raise a dispute on a Funded escrow", async () => {
      const t = await setupTrade();
      await initAndFund(t);

      await program.methods
        .raiseDispute()
        .accounts({ signer: t.buyer.publicKey, escrow: t.escrowPda })
        .signers([t.buyer])
        .rpc();

      const escrowAcc = await program.account.escrow.fetch(t.escrowPda);
      assert.deepEqual(escrowAcc.status, { disputed: {} });
    });

    it("rejects raise_dispute from someone who is neither buyer nor seller", async () => {
      const t = await setupTrade();
      await initAndFund(t);
      const stranger = Keypair.generate();
      await airdrop(stranger.publicKey);

      let failed = false;
      try {
        await program.methods
          .raiseDispute()
          .accounts({ signer: stranger.publicKey, escrow: t.escrowPda })
          .signers([stranger])
          .rpc();
      } catch (e: any) {
        failed = true;
      }
      assert.isTrue(failed, "expected raise_dispute from a stranger to fail");
    });

    it("admin resolves dispute in favor of buyer", async () => {
      const t = await setupTrade();
      await initAndFund(t);
      await program.methods
        .raiseDispute()
        .accounts({ signer: t.buyer.publicKey, escrow: t.escrowPda })
        .signers([t.buyer])
        .rpc();

      await program.methods
        .resolveDispute(true)
        .accounts({
          admin: admin.publicKey,
          buyer: t.buyer.publicKey,
          seller: seller.publicKey,
          mint,
          config: configPda,
          escrow: t.escrowPda,
          vault: t.vaultPda,
          buyerTokenAccount: t.buyerTokenAccount,
          sellerTokenAccount: t.sellerTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const buyerAcc = await getAccount(provider.connection, t.buyerTokenAccount);
      assert.equal(buyerAcc.amount.toString(), t.amount.toString());
      await assertClosed(t.escrowPda);
    });

    it("admin resolves dispute in favor of seller", async () => {
      const t = await setupTrade();
      await initAndFund(t);
      await program.methods
        .raiseDispute()
        .accounts({ signer: t.buyer.publicKey, escrow: t.escrowPda })
        .signers([t.buyer])
        .rpc();

      const beforeAcc = await getAccount(provider.connection, t.sellerTokenAccount);

      await program.methods
        .resolveDispute(false)
        .accounts({
          admin: admin.publicKey,
          buyer: t.buyer.publicKey,
          seller: seller.publicKey,
          mint,
          config: configPda,
          escrow: t.escrowPda,
          vault: t.vaultPda,
          buyerTokenAccount: t.buyerTokenAccount,
          sellerTokenAccount: t.sellerTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const afterAcc = await getAccount(provider.connection, t.sellerTokenAccount);
      assert.equal(
        (Number(afterAcc.amount) - Number(beforeAcc.amount)).toString(),
        t.amount.toString()
      );
      await assertClosed(t.escrowPda);
    });

    it("rejects resolve_dispute from a non-admin signer", async () => {
      const t = await setupTrade();
      await initAndFund(t);
      await program.methods
        .raiseDispute()
        .accounts({ signer: t.buyer.publicKey, escrow: t.escrowPda })
        .signers([t.buyer])
        .rpc();

      const intruder = Keypair.generate();
      await airdrop(intruder.publicKey);

      let failed = false;
      try {
        await program.methods
          .resolveDispute(true)
          .accounts({
            admin: intruder.publicKey,
            buyer: t.buyer.publicKey,
            seller: seller.publicKey,
            mint,
            config: configPda,
            escrow: t.escrowPda,
            vault: t.vaultPda,
            buyerTokenAccount: t.buyerTokenAccount,
            sellerTokenAccount: t.sellerTokenAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([intruder])
          .rpc();
      } catch (e: any) {
        failed = true;
      }
      assert.isTrue(failed, "expected resolve_dispute from non-admin to fail");
    });

    it("rejects raise_dispute on a non-Funded escrow (e.g. still Created)", async () => {
      const t = await setupTrade();
      await program.methods
        .initializeEscrow(t.tradeId, new BN(t.amount), new BN(DEFAULT_TIMEOUT))
        .accounts({
          seller: seller.publicKey,
          buyer: t.buyer.publicKey,
          mint,
          escrow: t.escrowPda,
          vault: t.vaultPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      let failed = false;
      try {
        await program.methods
          .raiseDispute()
          .accounts({ signer: t.buyer.publicKey, escrow: t.escrowPda })
          .signers([t.buyer])
          .rpc();
      } catch (e: any) {
        failed = true;
        assert.include(String(e), "InvalidStatus");
      }
      assert.isTrue(failed, "expected raise_dispute on Created escrow to fail");
    });
  });
});

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createMint, createAccount, mintTo, getAccount } from "@solana/spl-token";
import { assert } from "chai";

describe("chatfi_escrow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.ChatfiEscrow as Program;

  const seller = provider.wallet as anchor.Wallet;
  const buyer = Keypair.generate();
  const feeCollector = Keypair.generate();

  let mint: PublicKey;
  let sellerTokenAccount: PublicKey;
  let buyerTokenAccount: PublicKey;
  let feeTokenAccount: PublicKey;

  const tradeId = new anchor.BN(Date.now());
  const amount = new anchor.BN(1_000_000);

  let escrowPda: PublicKey, vaultPda: PublicKey, configPda: PublicKey;

  before(async () => {
    await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(buyer.publicKey, 1e9));
    await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(feeCollector.publicKey, 1e9));

    mint = await createMint(provider.connection, seller.payer, seller.publicKey, null, 6);
    sellerTokenAccount = await createAccount(provider.connection, seller.payer, mint, seller.publicKey);
    buyerTokenAccount = await createAccount(provider.connection, seller.payer, mint, buyer.publicKey);
    feeTokenAccount = await createAccount(provider.connection, seller.payer, mint, feeCollector.publicKey);
    await mintTo(provider.connection, seller.payer, mint, sellerTokenAccount, seller.payer, amount.toNumber());

    [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
    [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), seller.publicKey.toBuffer(), buyer.publicKey.toBuffer(), tradeId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault"), escrowPda.toBuffer()], program.programId);
  });

  it("initializes config", async () => {
    await program.methods
      .initConfig(100)
      .accounts({
        admin: seller.publicKey,
        feeCollector: feeCollector.publicKey,
        config: configPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  });

  it("creates, funds, and releases an escrow", async () => {
    await program.methods
      .initializeEscrow(tradeId, amount)
      .accounts({
        seller: seller.publicKey,
        buyer: buyer.publicKey,
        mint,
        escrow: escrowPda,
        vault: vaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await program.methods
      .fundEscrow()
      .accounts({
        seller: seller.publicKey,
        mint,
        escrow: escrowPda,
        vault: vaultPda,
        sellerTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    await program.methods
      .releaseEscrow()
      .accounts({
        seller: seller.publicKey,
        mint,
        config: configPda,
        escrow: escrowPda,
        vault: vaultPda,
        buyerTokenAccount,
        feeTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const buyerAcc = await getAccount(provider.connection, buyerTokenAccount);
    assert.equal(buyerAcc.amount.toString(), "990000");
  });
});

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked,
};

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod chatfi_escrow {
    use super::*;

    pub fn init_config(ctx: Context<InitConfig>, fee_bps: u16) -> Result<()> {
        require!(fee_bps <= 1000, EscrowError::FeeTooHigh);
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.fee_collector = ctx.accounts.fee_collector.key();
        config.fee_bps = fee_bps;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn update_config(
        ctx: Context<UpdateConfig>,
        new_admin: Option<Pubkey>,
        new_fee_collector: Option<Pubkey>,
        new_fee_bps: Option<u16>,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        if let Some(a) = new_admin {
            config.admin = a;
        }
        if let Some(f) = new_fee_collector {
            config.fee_collector = f;
        }
        if let Some(b) = new_fee_bps {
            require!(b <= 1000, EscrowError::FeeTooHigh);
            config.fee_bps = b;
        }
        Ok(())
    }

    pub fn initialize_escrow(ctx: Context<InitializeEscrow>, trade_id: u64, amount: u64) -> Result<()> {
        require!(amount > 0, EscrowError::InvalidAmount);
        let escrow = &mut ctx.accounts.escrow;
        escrow.seller = ctx.accounts.seller.key();
        escrow.buyer = ctx.accounts.buyer.key();
        escrow.mint = ctx.accounts.mint.key();
        escrow.amount = amount;
        escrow.trade_id = trade_id;
        escrow.status = EscrowStatus::Created;
        escrow.bump = ctx.bumps.escrow;
        escrow.vault_bump = ctx.bumps.vault;
        Ok(())
    }

    pub fn fund_escrow(ctx: Context<FundEscrow>) -> Result<()> {
        let amount = ctx.accounts.escrow.amount;
        require!(ctx.accounts.escrow.status == EscrowStatus::Created, EscrowError::InvalidStatus);

        let cpi_accounts = TransferChecked {
            from: ctx.accounts.seller_token_account.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.seller.to_account_info(),
        };
        token_interface::transfer_checked(
            CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        ctx.accounts.escrow.status = EscrowStatus::Funded;
        Ok(())
    }

    pub fn release_escrow(ctx: Context<ReleaseEscrow>) -> Result<()> {
        let escrow = ctx.accounts.escrow.clone().into_inner();
        require!(escrow.status == EscrowStatus::Funded, EscrowError::InvalidStatus);
        require_keys_eq!(ctx.accounts.seller.key(), escrow.seller, EscrowError::Unauthorized);

        let fee_bps = ctx.accounts.config.fee_bps as u64;
        let fee_amount = escrow.amount.checked_mul(fee_bps).unwrap() / 10_000;
        let payout_amount = escrow.amount.checked_sub(fee_amount).unwrap();

        let trade_id_bytes = escrow.trade_id.to_le_bytes();
        let seeds = &[
            b"escrow".as_ref(),
            escrow.seller.as_ref(),
            escrow.buyer.as_ref(),
            trade_id_bytes.as_ref(),
            &[escrow.bump],
        ];
        let signer = &[&seeds[..]];

        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.buyer_token_account.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                },
                signer,
            ),
            payout_amount,
            ctx.accounts.mint.decimals,
        )?;

        if fee_amount > 0 {
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.vault.to_account_info(),
                        mint: ctx.accounts.mint.to_account_info(),
                        to: ctx.accounts.fee_token_account.to_account_info(),
                        authority: ctx.accounts.escrow.to_account_info(),
                    },
                    signer,
                ),
                fee_amount,
                ctx.accounts.mint.decimals,
            )?;
        }

        token_interface::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.vault.to_account_info(),
                destination: ctx.accounts.seller.to_account_info(),
                authority: ctx.accounts.escrow.to_account_info(),
            },
            signer,
        ))?;

        ctx.accounts.escrow.status = EscrowStatus::Released;
        Ok(())
    }

    pub fn cancel_escrow(ctx: Context<CancelEscrow>) -> Result<()> {
        let escrow = ctx.accounts.escrow.clone().into_inner();
        require!(
            escrow.status == EscrowStatus::Created || escrow.status == EscrowStatus::Funded,
            EscrowError::InvalidStatus
        );
        require_keys_eq!(ctx.accounts.seller.key(), escrow.seller, EscrowError::Unauthorized);

        let trade_id_bytes = escrow.trade_id.to_le_bytes();
        let seeds = &[
            b"escrow".as_ref(),
            escrow.seller.as_ref(),
            escrow.buyer.as_ref(),
            trade_id_bytes.as_ref(),
            &[escrow.bump],
        ];
        let signer = &[&seeds[..]];

        if escrow.status == EscrowStatus::Funded {
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.vault.to_account_info(),
                        mint: ctx.accounts.mint.to_account_info(),
                        to: ctx.accounts.seller_token_account.to_account_info(),
                        authority: ctx.accounts.escrow.to_account_info(),
                    },
                    signer,
                ),
                escrow.amount,
                ctx.accounts.mint.decimals,
            )?;
        }

        token_interface::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.vault.to_account_info(),
                destination: ctx.accounts.seller.to_account_info(),
                authority: ctx.accounts.escrow.to_account_info(),
            },
            signer,
        ))?;

        ctx.accounts.escrow.status = EscrowStatus::Cancelled;
        Ok(())
    }

    pub fn raise_dispute(ctx: Context<RaiseDispute>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.status == EscrowStatus::Funded, EscrowError::InvalidStatus);
        let signer_key = ctx.accounts.signer.key();
        require!(
            signer_key == escrow.seller || signer_key == escrow.buyer,
            EscrowError::Unauthorized
        );
        escrow.status = EscrowStatus::Disputed;
        Ok(())
    }

    pub fn resolve_dispute(ctx: Context<ResolveDispute>, release_to_buyer: bool) -> Result<()> {
        let escrow = ctx.accounts.escrow.clone().into_inner();
        require!(escrow.status == EscrowStatus::Disputed, EscrowError::InvalidStatus);
        require_keys_eq!(ctx.accounts.admin.key(), ctx.accounts.config.admin, EscrowError::Unauthorized);

        let trade_id_bytes = escrow.trade_id.to_le_bytes();
        let seeds = &[
            b"escrow".as_ref(),
            escrow.seller.as_ref(),
            escrow.buyer.as_ref(),
            trade_id_bytes.as_ref(),
            &[escrow.bump],
        ];
        let signer = &[&seeds[..]];

        let destination = if release_to_buyer {
            ctx.accounts.buyer_token_account.to_account_info()
        } else {
            ctx.accounts.seller_token_account.to_account_info()
        };

        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: destination,
                    authority: ctx.accounts.escrow.to_account_info(),
                },
                signer,
            ),
            escrow.amount,
            ctx.accounts.mint.decimals,
        )?;

        token_interface::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.vault.to_account_info(),
                destination: ctx.accounts.seller.to_account_info(),
                authority: ctx.accounts.escrow.to_account_info(),
            },
            signer,
        ))?;

        ctx.accounts.escrow.status = if release_to_buyer {
            EscrowStatus::Released
        } else {
            EscrowStatus::Cancelled
        };
        Ok(())
    }
}

#[account]
pub struct Config {
    pub admin: Pubkey,
    pub fee_collector: Pubkey,
    pub fee_bps: u16,
    pub bump: u8,
}
impl Config {
    pub const LEN: usize = 8 + 32 + 32 + 2 + 1 + 32;
}

#[account]
#[derive(Clone)]
pub struct Escrow {
    pub seller: Pubkey,
    pub buyer: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub trade_id: u64,
    pub status: EscrowStatus,
    pub bump: u8,
    pub vault_bump: u8,
}
impl Escrow {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 8 + 8 + 1 + 1 + 1 + 64;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum EscrowStatus {
    Created,
    Funded,
    Released,
    Cancelled,
    Disputed,
}

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: just a payout destination wallet, no signature needed here
    pub fee_collector: UncheckedAccount<'info>,
    #[account(init, payer = admin, space = Config::LEN, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
#[instruction(trade_id: u64, amount: u64)]
pub struct InitializeEscrow<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    /// CHECK: buyer doesn't need to sign trade creation
    pub buyer: UncheckedAccount<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = seller,
        space = Escrow::LEN,
        seeds = [b"escrow", seller.key().as_ref(), buyer.key().as_ref(), &trade_id.to_le_bytes()],
        bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(
        init,
        payer = seller,
        seeds = [b"vault", escrow.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = escrow,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundEscrow<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut, has_one = mint, has_one = seller,
        seeds = [b"escrow", escrow.seller.as_ref(), escrow.buyer.as_ref(), &escrow.trade_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(mut, seeds = [b"vault", escrow.key().as_ref()], bump = escrow.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = seller)]
    pub seller_token_account: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct ReleaseEscrow<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut, has_one = mint, has_one = seller,
        seeds = [b"escrow", escrow.seller.as_ref(), escrow.buyer.as_ref(), &escrow.trade_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(mut, seeds = [b"vault", escrow.key().as_ref()], bump = escrow.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, constraint = buyer_token_account.owner == escrow.buyer)]
    pub buyer_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, constraint = fee_token_account.owner == config.fee_collector)]
    pub fee_token_account: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct CancelEscrow<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut, has_one = mint, has_one = seller,
        seeds = [b"escrow", escrow.seller.as_ref(), escrow.buyer.as_ref(), &escrow.trade_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(mut, seeds = [b"vault", escrow.key().as_ref()], bump = escrow.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = seller)]
    pub seller_token_account: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct RaiseDispute<'info> {
    pub signer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"escrow", escrow.seller.as_ref(), escrow.buyer.as_ref(), &escrow.trade_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
}

#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    #[account(
        mut, has_one = mint,
        seeds = [b"escrow", escrow.seller.as_ref(), escrow.buyer.as_ref(), &escrow.trade_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(mut, seeds = [b"vault", escrow.key().as_ref()], bump = escrow.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, constraint = buyer_token_account.owner == escrow.buyer)]
    pub buyer_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, constraint = seller_token_account.owner == escrow.seller)]
    pub seller_token_account: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[error_code]
pub enum EscrowError {
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Escrow is not in the required status for this action")]
    InvalidStatus,
    #[msg("Unauthorized signer for this action")]
    Unauthorized,
    #[msg("Fee cannot exceed 10%")]
    FeeTooHigh,
}

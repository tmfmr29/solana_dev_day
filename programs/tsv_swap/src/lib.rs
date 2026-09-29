use anchor_lang::prelude::*;
use anchor_lang::system_program::{create_account, CreateAccount};
use anchor_spl::token_2022::spl_token_2022::{
    extension::{transfer_hook::TransferHookAccount, BaseStateWithExtensions, StateWithExtensions},
    state::Account as Token2022Account,
};
use anchor_spl::token_interface::{Mint, TokenAccount};
use spl_tlv_account_resolution::{
    account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList,
};
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

declare_id!("7KmjcBRHVjjhqxjihdJAFvfukbjhnNP82QPpVevbxkTn");

#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "TSV Swap Compliance Transfer Hook",
    project_url: "https://github.com/tmfmr29/solana_dev_day",
    contacts: "email:tim.mindray@gmail.com",
    policy: "Prototype for a tokenized-security venue (SEC TSV exemption). Please report issues by email.",
    preferred_languages: "en"
}

/// The SPL TLV crate uses a different copy of Solana's error type than Anchor,
/// so convert through the raw error number.
fn tlv_err<E: Into<u64>>(e: E) -> Error {
    Error::from(ProgramError::from(e.into()))
}

#[program]
pub mod tsv_swap {
    use super::*;

    /// 0. One-time setup: whoever pays for this becomes the admin. Can only run once.
    pub fn initialize_config(ctx: Context<InitializeConfig>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.halted = false;
        config.bump = ctx.bumps.config;
        msg!("Config initialized. Admin: {}", config.admin);
        Ok(())
    }

    /// Admin switch: halt or resume ALL tNVDA transfers (SEC trading-halt capability).
    pub fn set_trading_halt(ctx: Context<AdminOnly>, halted: bool) -> Result<()> {
        ctx.accounts.config.halted = halted;
        msg!("Trading halted = {}", halted);
        Ok(())
    }

    /// 1. Admin sets the user's KYC status (Simulating the MoonPay Webhook)
    pub fn update_kyc_status(
        ctx: Context<UpdateKyc>,
        is_us_person: bool,
        is_ofac_sanctioned: bool,
        kyc_cleared: bool,
    ) -> Result<()> {
        let profile = &mut ctx.accounts.compliance_profile;
        profile.wallet_address = ctx.accounts.user_wallet.key();
        profile.is_us_person = is_us_person;
        profile.is_ofac_sanctioned = is_ofac_sanctioned;
        profile.kyc_cleared = kyc_cleared;

        msg!("KYC Profile updated for wallet: {}", profile.wallet_address);
        Ok(())
    }

    /// 2. One-time setup per mint. Tells Token-2022 which extra accounts
    /// (the two compliance profiles and the config) to pass into the hook on every transfer.
    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
    ) -> Result<()> {
        // Account indices in the execute instruction:
        // 0 = source token account, 1 = mint, 2 = destination token account,
        // 3 = owner, 4 = extra_account_meta_list, then the extras below.
        // A token account stores its owner pubkey at byte offset 32.
        let account_metas = vec![
            // source_profile = PDA["compliance", source_account.owner]
            ExtraAccountMeta::new_with_seeds(
                &[
                    Seed::Literal { bytes: b"compliance".to_vec() },
                    Seed::AccountData { account_index: 0, data_index: 32, length: 32 },
                ],
                false,
                false,
            )
            .map_err(tlv_err)?,
            // destination_profile = PDA["compliance", destination_account.owner]
            ExtraAccountMeta::new_with_seeds(
                &[
                    Seed::Literal { bytes: b"compliance".to_vec() },
                    Seed::AccountData { account_index: 2, data_index: 32, length: 32 },
                ],
                false,
                false,
            )
            .map_err(tlv_err)?,
            // config = PDA["config"]  (carries the trading-halt flag)
            ExtraAccountMeta::new_with_seeds(
                &[Seed::Literal { bytes: b"config".to_vec() }],
                false,
                false,
            )
            .map_err(tlv_err)?,
        ];

        let account_size =
            ExtraAccountMetaList::size_of(account_metas.len()).map_err(tlv_err)? as u64;
        let lamports = Rent::get()?.minimum_balance(account_size as usize);

        let mint = ctx.accounts.mint.key();
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"extra-account-metas",
            mint.as_ref(),
            &[ctx.bumps.extra_account_meta_list],
        ]];

        create_account(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                CreateAccount {
                    from: ctx.accounts.admin.to_account_info(),
                    to: ctx.accounts.extra_account_meta_list.to_account_info(),
                },
            )
            .with_signer(signer_seeds),
            lamports,
            account_size,
            ctx.program_id,
        )?;

        ExtraAccountMetaList::init::<ExecuteInstruction>(
            &mut ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?,
            &account_metas,
        )
        .map_err(tlv_err)?;

        msg!("ExtraAccountMetaList initialized for mint {}", mint);
        Ok(())
    }

    /// 3. The Transfer Hook Execution (Triggered automatically by Token-2022)
    /// This intercepts every tNVDA transfer and enforces the SEC exemption rules.
    #[instruction(discriminator = &[105, 37, 101, 197, 75, 251, 102, 26])]
    pub fn execute_transfer(ctx: Context<ExecuteTransfer>, amount: u64) -> Result<()> {
        // Rule 0: only run as part of a real Token-2022 transfer, never called directly.
        check_is_transferring(&ctx)?;

        // Rule 1: global trading halt
        require!(!ctx.accounts.config.halted, ComplianceError::TradingHalted);

        let source_profile = &ctx.accounts.source_profile;
        let destination_profile = &ctx.accounts.destination_profile;

        // Rule 2: Block transactions involving OFAC sanctioned entities
        require!(
            !source_profile.is_ofac_sanctioned && !destination_profile.is_ofac_sanctioned,
            ComplianceError::SanctionedEntity
        );

        // Rule 3: Enforce the SEC TSV Exemption criteria (Verified U.S. Persons only)
        require!(destination_profile.is_us_person, ComplianceError::NotUSPerson);
        require!(destination_profile.kyc_cleared, ComplianceError::KycNotCleared);

        msg!("[SUCCESS] SEC Compliance Transfer Hook cleared for {} tokens.", amount);
        Ok(())
    }
}

/// Token-2022 sets a "transferring" flag on the source account for the duration of a
/// transfer. If it's not set, someone is calling the hook directly.
fn check_is_transferring(ctx: &Context<ExecuteTransfer>) -> Result<()> {
    let info = ctx.accounts.source_account.to_account_info();
    let data = info.try_borrow_data()?;
    let state = StateWithExtensions::<Token2022Account>::unpack(&data)
        .map_err(|_| error!(ComplianceError::NotTransferring))?;
    let ext = state
        .get_extension::<TransferHookAccount>()
        .map_err(|_| error!(ComplianceError::NotTransferring))?;
    require!(bool::from(ext.transferring), ComplianceError::NotTransferring);
    Ok(())
}

// --- Accounts & State ---

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin @ ComplianceError::Unauthorized)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct UpdateKyc<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin @ ComplianceError::Unauthorized)]
    pub config: Account<'info, Config>,
    /// CHECK: The user wallet being whitelisted
    pub user_wallet: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + ComplianceProfile::INIT_SPACE,
        seeds = [b"compliance", user_wallet.key().as_ref()],
        bump
    )]
    pub compliance_profile: Account<'info, ComplianceProfile>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeExtraAccountMetaList<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin @ ComplianceError::Unauthorized)]
    pub config: Account<'info, Config>,
    /// CHECK: Created and written in the instruction. Seeds are fixed by the SPL spec.
    #[account(
        mut,
        seeds = [b"extra-account-metas", mint.key().as_ref()],
        bump
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExecuteTransfer<'info> {
    #[account(token::mint = mint)]
    pub source_account: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(token::mint = mint)]
    pub destination_account: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: Owner of the source account
    pub owner: UncheckedAccount<'info>,
    /// CHECK: MetaList account required by the SPL interface
    #[account(
        seeds = [b"extra-account-metas", mint.key().as_ref()],
        bump
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,

    // Custom Extra Accounts resolved by the hook
    #[account(
        seeds = [b"compliance", source_account.owner.as_ref()],
        bump
    )]
    pub source_profile: Account<'info, ComplianceProfile>,
    #[account(
        seeds = [b"compliance", destination_account.owner.as_ref()],
        bump
    )]
    pub destination_profile: Account<'info, ComplianceProfile>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub halted: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ComplianceProfile {
    pub wallet_address: Pubkey,
    pub is_us_person: bool,
    pub is_ofac_sanctioned: bool,
    pub kyc_cleared: bool,
}

// --- Custom Errors ---

#[error_code]
pub enum ComplianceError {
    #[msg("[REVERT] Transaction blocked: Wallet is flagged by OFAC sanctions screening.")]
    SanctionedEntity,
    #[msg("[REVERT] Transaction blocked: Receiver is not a verified U.S. Person.")]
    NotUSPerson,
    #[msg("[REVERT] Transaction blocked: Receiver has not cleared KYC requirements.")]
    KycNotCleared,
    #[msg("[REVERT] Trading is currently halted by the venue administrator.")]
    TradingHalted,
    #[msg("Only the venue administrator may perform this action.")]
    Unauthorized,
    #[msg("Hook must be invoked by Token-2022 during a transfer.")]
    NotTransferring,
}

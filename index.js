import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { createJupiterApiClient } from "@jup-ag/api";
import { MarginfiClient, getConfig } from "@mrgnlabs/marginfi-client-v2";
import { NodeWallet } from "@mrgnlabs/mrgn-common";
import "dotenv/config";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { TransactionInstruction } from "@solana/web3.js";

const BASE_MINT = "So11111111111111111111111111111111111111112"; // WSOL Mint address

const ARB_MINTS = ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"]; // USDC Mint address

const SOL_PER_LAMPORTS = 1 / LAMPORTS_PER_SOL;

const TRADE_AMOUNT = 4000; // SOL

const MIN_PROFIT_SOL = 0.1; // SOL

const jup = createJupiterApiClient({
    basePath: process.env.JUPITER_BASE_PATH,
});

const connection = new Connection(
    process.env.RPC_URL,
    {
        commitment: "confirmed",
    }
);

const deserializeInstruction = (instruction) => {
    return new TransactionInstruction({
        programId: new PublicKey(instruction.programId),
        keys: instruction.accounts.map((key) => ({
            pubkey: new PublicKey(key.pubkey),
            isSigner: key.isSigner,
            isWritable: key.isWritable,
        })),
        data: Buffer.from(instruction.data, "base64"),
    });
};

class ArbitrageBotV1 {
    constructor(connection, wallet, executeTransactionWithFlashloan) {
        this.connection = connection;
        this.wallet = wallet;
        this.executeTransactionWithFlashloan = executeTransactionWithFlashloan;
    }

    async findArbitrageOpportunities(baseToken, quoteTokens) {
        const opportunities = [];

        for (const quoteToken of quoteTokens) {
            try {
                const buyRoute = await jup.quoteGet({
                    inputMint: baseToken,
                    outputMint: quoteToken,
                    amount: TRADE_AMOUNT * LAMPORTS_PER_SOL,
                    onlyDirectRoutes: false,
                    slippageBps: 50,
                    // maxAccounts: 20,
                    excludeDexes: ["Obric V2"],
                });

                const sellRoute = await jup.quoteGet({
                    inputMint: quoteToken,
                    outputMint: baseToken,
                    amount: buyRoute.outAmount,
                    onlyDirectRoutes: false,
                    slippageBps: 0,
                    // maxAccounts: 20,
                    excludeDexes: ["Obric V2"],
                });

                // Calculate potential arbitrage profit
                const profit =
                    (sellRoute.outAmount - buyRoute.inAmount) /
                    LAMPORTS_PER_SOL;

                if (profit > MIN_PROFIT_SOL) {
                    let mergedQuote = buyRoute;
                    mergedQuote.outputMint = sellRoute.outputMint;
                    mergedQuote.outAmount = String(
                        TRADE_AMOUNT * LAMPORTS_PER_SOL
                    );
                    mergedQuote.otherAmountThreshold = String(
                        TRADE_AMOUNT * LAMPORTS_PER_SOL
                    );
                    mergedQuote.priceImpactPct = "0";
                    mergedQuote.routePlan = mergedQuote.routePlan.concat(
                        sellRoute.routePlan
                    );

                    const [swapInstructions] = await Promise.all([
                        jup.swapInstructionsPostRaw({
                            swapRequest: {
                                userPublicKey: this.wallet.publicKey,
                                quoteResponse: mergedQuote,
                                wrapAndUnwrapSol: false,

                                useSharedAccounts: false,
                                computeUnitPriceMicroLamports: 1,
                                dynamicComputeUnitLimit: true,

                                skipUserAccountsRpcCalls: true,
                            },
                        }),
                    ]);
                    console.log({
                        baseToken,
                        quoteToken,
                        route: `${buyRoute.routePlan
                            .map((amm) => amm.swapInfo.label)
                            .join(", ")} -> ${sellRoute.routePlan
                            .map((amm) => amm.swapInfo.label)
                            .join(", ")}`,
                        profit: profit,
                    });
                    opportunities.push({
                        baseToken,
                        quoteToken,
                        profitInSOL: profit,
                        swapInstructions,
                    });
                }
            } catch (error) {
                console.error(`Error checking route for ${quoteToken}:`, error);
            }
        }

        return opportunities;
    }

    async sortInstructions(opportunity) {

        let swapInstructions = await opportunity.swapInstructions.raw.json();

        const addressLookupTableAccounts = await Promise.all(
            swapInstructions.addressLookupTableAddresses.map(
                async (address) => {
                    const result = await connection.getAddressLookupTable(
                        new PublicKey(address)
                    );
                    return result.value;
                }
            )
        );

        return {
            computeInstructions: swapInstructions.computeBudgetInstructions.map(
                (ix) => deserializeInstruction(ix)
            ),
            setupInstructions: swapInstructions.setupInstructions.map((ix) =>
                deserializeInstruction(ix)
            ),
            swapInstruction: deserializeInstruction(
                swapInstructions.swapInstruction
            ),
            addressLookupTableAccounts,
        };
    }

    async executeArbitrage(opportunity) {
        try {
            let ixMap = await this.sortInstructions(opportunity);
            await this.executeTransactionWithFlashloan(ixMap);
        } catch (error) {
            console.error("Arbitrage execution failed:", error);
        }
    }

    async runBot() {
        // Example tokens (replace with actual token addresses)
        const baseToken = BASE_MINT;
        const quoteTokens = ARB_MINTS;

        while (true) {
            const opportunities = await this.findArbitrageOpportunities(
                baseToken,
                quoteTokens
            );

            if (opportunities[0]) {
                try {
                    await this.executeArbitrage(opportunities[0]);
                    await new Promise((resolve) =>
                        setTimeout(resolve, 1000 * 60 * 60 * 24)
                    );
                } catch (err) {
                    console.log(`Failed to arb: ${err}`);
                }
            }

            // Wait before next scan to avoid rate limits
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
    }
}

// Usage example
async function startArbitrageBot() {
    const wallet = Keypair.fromSecretKey(bs58.decode(process.env.SECRET_KEY));

    const config = getConfig("production");
    const client = await MarginfiClient.fetch(
        config,
        new NodeWallet(wallet),
        connection
    );

    const bankLabel = "SOL";
    const solBank = client.getBankByTokenSymbol(bankLabel);
    if (!solBank) throw Error(`${bankLabel} bank not found`);

    const amount = TRADE_AMOUNT;

    const marginfiAccounts = await client.getMarginfiAccountsForAuthority();
    if (marginfiAccounts.length === 0) {
        marginfiAccounts[0] = await client.createMarginfiAccount(
            {},
            { bundleTipUi: SOL_PER_LAMPORTS * 5000 }
        );
    }

    let marginfiAccount = marginfiAccounts[0];

    async function executeTransactionWithFlashloan(ixMap) {
        const borrowIx = await marginfiAccount.makeBorrowIx(
            amount,
            solBank.address,
            { createAtas: false, wrapAndUnwrapSol: false }
        );
        const repayIx = await marginfiAccount.makeRepayIx(
            amount,
            solBank.address,
            true,
            { createAtas: false, wrapAndUnwrapSol: false }
        );

        let ixs = [
            ...ixMap.computeInstructions,
            ...ixMap.setupInstructions,
            ...borrowIx.instructions.splice(-1),
            ixMap.swapInstruction,
            ...repayIx.instructions,
        ];

        const flashLoanTx = await marginfiAccount.buildFlashLoanTx(
            {
                ixs,
                signers: [],
            },
            ixMap.addressLookupTableAccounts
        );

        flashLoanTx.sign([wallet]);

        let sig = await connection.sendRawTransaction(flashLoanTx.serialize(), {
            skipPreflight: true,
        });
        console.log(sig);
    }

    const bot = new ArbitrageBotV1(
        connection,
        wallet,
        executeTransactionWithFlashloan
    );
    await bot.runBot();
}

startArbitrageBot();

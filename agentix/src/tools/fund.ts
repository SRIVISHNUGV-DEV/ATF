export interface FiatOnRampOption {
  provider: string;
  logo: string;
  estimatedPrice: string;
  fees: string;
  /** Numeric fee in fiat, for programmatic comparison. */
  feeAmount: number;
  estimatedETH: string;
  /** Numeric ETH received after fees, for programmatic comparison. */
  ethReceived: number;
  estimatedArrival: string;
  officialLink: string;
  supportedCountries: string[];
  currencies: string[];
  /** True for the single option that returns the most ETH for the money. */
  bestValue?: boolean;
}

export interface FundRequest {
  network: string;
  amount: string;
  currency?: string;
  country?: string;
}

export interface FundResult {
  network: string;
  requestedAmount: string;
  currency: string;
  /** ETH/USD price used to estimate the amounts (live when available). */
  ethPriceUsd: number;
  /** Whether ethPriceUsd came from a live oracle vs the static fallback. */
  livePrice: boolean;
  /** The single cheapest/most-ETH option (also flagged in options[]). */
  bestOption: FiatOnRampOption | null;
  options: FiatOnRampOption[];
  disclaimer: string;
}

// Provider templates. The numeric comparison fields (feeAmount, ethReceived)
// and bestValue flag are computed per-request in getFundOptions.
type ProviderTemplate = Omit<FiatOnRampOption, "feeAmount" | "ethReceived" | "bestValue">;

const PROVIDERS: ProviderTemplate[] = [
  {
    provider: "MoonPay",
    logo: "moonpay",
    estimatedPrice: "",
    fees: "2.5% + network fee",
    estimatedETH: "",
    estimatedArrival: "2-10 minutes",
    officialLink: "https://www.moonpay.com",
    supportedCountries: ["US", "EU", "UK", "CA", "AU", "SG", "JP", "BR", "MX"],
    currencies: ["USD", "EUR", "GBP", "CAD", "AUD", "SGD", "JPY", "BRL", "MXN"],
  },
  {
    provider: "Coinbase",
    logo: "coinbase",
    estimatedPrice: "",
    fees: "1.99% + spread",
    estimatedETH: "",
    estimatedArrival: "Instant - 5 minutes",
    officialLink: "https://www.coinbase.com",
    supportedCountries: ["US", "EU", "UK", "CA", "AU", "SG"],
    currencies: ["USD", "EUR", "GBP", "CAD", "AUD", "SGD"],
  },
  {
    provider: "Transak",
    logo: "transak",
    estimatedPrice: "",
    fees: "1.5% - 5.5%",
    estimatedETH: "",
    estimatedArrival: "1-10 minutes",
    officialLink: "https://transak.com",
    supportedCountries: ["US", "EU", "UK", "CA", "AU", "IN", "BR", "NG", "PH"],
    currencies: ["USD", "EUR", "GBP", "CAD", "AUD", "INR", "BRL", "NGN", "PHP"],
  },
  {
    provider: "Ramp",
    logo: "ramp",
    estimatedPrice: "",
    fees: "0.99% - 2.9%",
    estimatedETH: "",
    estimatedArrival: "Instant - 5 minutes",
    officialLink: "https://ramp.network",
    supportedCountries: ["US", "EU", "UK", "CA", "AU", "SG", "JP"],
    currencies: ["USD", "EUR", "GBP", "CAD", "AUD", "SGD", "JPY"],
  },
];

const NETWORK_NAMES: Record<string, string> = {
  base: "Base",
  baseSepolia: "Base Sepolia",
  ethereum: "Ethereum",
  ethereumSepolia: "Ethereum Sepolia",
  polygon: "Polygon",
};

// Static fallback used only when no live price is supplied and the oracle is
// unreachable. Kept intentionally conservative.
const FALLBACK_ETH_USD = 2500;

const FEE_RATES: Record<string, number> = {
  MoonPay: 0.025,
  Coinbase: 0.0199,
  Transak: 0.035,
  Ramp: 0.0199,
};

export function getFundOptions(request: FundRequest, ethPrice?: number): FundResult {
  const { network, amount, currency = "USD", country } = request;
  const networkName = NETWORK_NAMES[network] || network;

  const amountNum = parseFloat(amount);
  const livePrice = typeof ethPrice === "number" && ethPrice > 0;
  const price = livePrice ? (ethPrice as number) : FALLBACK_ETH_USD;
  const isTestnet = /sepolia|testnet/i.test(network);
  const options: FiatOnRampOption[] = [];

  for (const provider of PROVIDERS) {
    if (country && !provider.supportedCountries.includes(country)) continue;
    if (!provider.currencies.includes(currency)) continue;

    const feeRate = FEE_RATES[provider.provider] ?? 0.025;
    const fee = amountNum * feeRate;
    const netAmount = amountNum - fee;
    const ethReceived = netAmount / price;
    const networkFee = isTestnet ? "Free (testnet)" : "0.0001 ETH";

    options.push({
      ...provider,
      estimatedPrice: `$${amountNum.toFixed(2)}`,
      fees: `$${fee.toFixed(2)} (${(feeRate * 100).toFixed(1)}%) + ${networkFee}`,
      feeAmount: fee,
      estimatedETH: `${ethReceived.toFixed(6)} ETH`,
      ethReceived,
      estimatedArrival: provider.estimatedArrival,
      officialLink: `${provider.officialLink}/buy/ETH?network=${network.toLowerCase()}&amount=${amount}&currency=${currency}`,
    });
  }

  // Best value = most ETH received for the money (equivalently, lowest fee).
  options.sort((a, b) => b.ethReceived - a.ethReceived);
  const bestOption = options[0] ?? null;
  if (bestOption) bestOption.bestValue = true;

  return {
    network: networkName,
    requestedAmount: `$${amount}`,
    currency,
    ethPriceUsd: price,
    livePrice,
    bestOption,
    options,
    disclaimer:
      "These are recommendations only. Always verify prices and fees on the provider's official website before purchasing. Never share your private keys or seed phrase.",
  };
}

/**
 * Live-priced variant: pulls the current ETH/USD from the price oracle
 * (Chainlink → Binance → CoinGecko) so the "best value" comparison reflects
 * real market conditions. Falls back to a static estimate if all sources fail.
 */
export async function getFundOptionsLive(request: FundRequest): Promise<FundResult> {
  let price = 0;
  try {
    const { getEthUsdPrice } = await import("../core/price-oracle");
    price = await getEthUsdPrice();
  } catch {
    /* oracle unavailable — getFundOptions falls back to a static estimate */
  }
  return getFundOptions(request, price > 0 ? price : undefined);
}

export function getNetworkInfo(network: string): { name: string; testnet: boolean; faucetUrl?: string } {
  const networks: Record<string, { name: string; testnet: boolean; faucetUrl?: string }> = {
    base: { name: "Base", testnet: false },
    baseSepolia: { name: "Base Sepolia", testnet: true, faucetUrl: "https://www.alchemy.com/faucets/base-sepolia" },
    ethereum: { name: "Ethereum", testnet: false },
    ethereumSepolia: { name: "Ethereum Sepolia", testnet: true, faucetUrl: "https://sepoliafaucet.com" },
    polygon: { name: "Polygon", testnet: false },
  };
  return networks[network] || { name: network, testnet: false };
}

// Explicitly requested provider products. XI means the provider's international
// offer; it can be mirrored into our allowed markets, never into extra countries.
export const SERVICE_PROVIDER_PRODUCTS = [
  "ppq-ai-international", "openai-usa", "nordvpn-international",
  "claude-ppq-international", "surfshark-vpn-international", "office-usa",
  "google-workspace-usa", "exitlag-international", "my-instant-ai-international",
  "gemini-ppq-international", "nordlocker-international", "nordpass-international",
] as const;

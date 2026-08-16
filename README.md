# 👑 King of the Hill

**One crown. A rising price. Territory by ratio.**

Live: **https://kingofthehill.3labsio.workers.dev**

Pay the current price to take the crown. The price then rises 1.5× for whoever comes next,
so every take costs more than the last. Your share of the board is your share of *everything
ever paid* — not fixed pixels-for-dollars, so it re-normalises each time someone buys in.

Paid per-take in USDC on Base via [x402](https://x402.org). No account, no API key: POST
without payment, get a 402 quoting the **current** price, sign, retry.

```bash
curl -s -X POST https://kingofthehill.3labsio.workers.dev/claim \
  -H 'content-type: application/json' \
  -d '{"name":"your-handle"}'
```

| endpoint | cost | what |
|---|---|---|
| `GET /` | free | the board |
| `GET /api/state` | free | king, price, territory, history |
| `GET /.well-known/x402` | free | discovery manifest |
| `GET /claim` | free | docs + current price |
| `POST /claim` | **current price** | take the crown |

## Why the price rises

A flat price makes a leaderboard. A rising price makes a *game* — each crown costs more than
the last, so taking it means something, and the pot grows superlinearly. Dynamic pricing is
possible because we generate the 402 challenge ourselves: `amount` is computed per request,
not read from config.

## Built on

The same x402 payment machinery as [policy-gate](https://github.com/fieldproofhq/policy-gate)
— one payment implementation, two products. Includes the fix that kept that service out of
the CDP Bazaar for six days: the Bazaar declaration must ride on the `paymentRequirements`
sent to the **facilitator**, not only on the buyer-facing 402
([x402-foundation/x402#2112](https://github.com/x402-foundation/x402/issues/2112)).

Every dollar is public and on-chain: receive wallet
[`0x07C2…4fb3`](https://basescan.org/address/0x07C2383008a9ed30581f27Db5531E19411c94fb3).

Built by [@FieldProofAI](https://x.com/FieldProofAI), an AI-run business with human gates.

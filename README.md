# Journey Juno Assistant

here is my zip file project create ui for it so that there are both dark and light mode and user can choose the one he wants and also give me link so that i can send it to anyone so that they can use my chatbot . if u need api keys and so on i can give them to. you but secretely Please prepare it for publishing and give me a public link. Do NOT rewrite or refactor any code in src/lib/assistant, src/lib/scrapers.server.ts, src/lib/bir.ts or src/test — they are finished and tested. 1. Check that the project builds (`vite build`) and that `npm test` passes. If something fails, tell me the exact error before changing anything. 2. Make sure these secrets exist in Lovable Cloud -> Secrets (ask me to enter the values; never put them in code or in the frontend): - COMPANY_AI_KEY (Azure OpenAI key, deployment "gpt-5.4-superchat" on resource "ai-ds-coe-resource") - TRAVELPAYOUTS_TOKEN (flight prices) - TAVILY_API_KEY (web search for visa rules, hotels, buses, trains) Optional: TRAVELPAYOUTS_MARKER, STATE_SECRET, ASSISTANT_DEBUG. 3. The server must be allowed to make outgoing requests to: ai-ds-coe-resource.openai.azure.com, api.travelpayouts.com, autocomplete.travelpayouts.com, api.tavily.com, open.er-api.com, cinemastercard.az, birmarket.az. Confirm nothing blocks them. 4. Publish the app and give me the public URL.

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://journey-juno-assistant.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/8d181033-2b12-4c8f-8426-7dad6bffcdd3).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```

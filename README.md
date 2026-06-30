Quill AI

A full-stack creative writing platform that helps authors plan, draft, and manage their stories. Writers can organize their work into series, books, and chapters, build out a cast of characters and entities, track relationships between those entities, and chat with an AI assistant that has context about their world.

## Features

- **Series & Book Management** — Organize stories into series with books and ordered chapters
- **Chapter Drafting** — Write and edit chapters with full version history
- **Entity & Character Tracking** — Maintain a cast of characters and other entities with images and notes
- **Entity Relationship Diagrams** — Visualize how characters and entities relate to one another
- **Book Notes** — Attach free-form notes to any book
- **AI Assistant** — Persistent, multi-session chat with an AI that can answer questions about your story
- **AI Image Generation** — Generate cover art and character illustrations from natural language prompts
- **Grammar Checking** — AI-powered grammar and prose review
- **Export** — Export books to DOCX, PDF, or HTML
- **Collaboration** — Share series with other users via email invite
- **Google Sign-In** — Secure authentication via Google Identity Services

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Angular 20, Angular Material, TypeScript |
| Backend | Node.js, Express 5, TypeScript |
| Database | Azure Cosmos DB (NoSQL) |
| File Storage | Azure Blob Storage |
| AI / LLM | Azure AI Foundry (chat, embeddings, image generation) |
| AI / LLM (alt) | Google AI Studio (Gemini) |
| Auth | Google Identity Services + custom JWT |
| Hosting | Azure App Service |
| CI/CD | GitHub Actions |

---

## Cloud Services Required

### Azure Cosmos DB
Stores all application data: series, books, chapters, entities, chat sessions, entity relationships, book notes, and more. The chapters container uses vector embeddings for semantic search.

| Config Key | Environment Variable |
|---|---|
| `cosmosEndpoint` | `COSMOS_ENDPOINT` |
| `cosmosKey` | `COSMOS_KEY` |
| `cosmosDatabase` | `COSMOS_DATABASE` |

### Azure Blob Storage
Stores uploaded and AI-generated images (cover art, character portraits, etc.).

| Config Key | Environment Variable |
|---|---|
| `storageAccountName` | `STORAGE_ACCOUNT_NAME` |
| `storageAccountKey` | `STORAGE_ACCOUNT_KEY` |
| `storageContainerName` | `STORAGE_CONTAINER_NAME` |

### Azure AI Foundry
Provides the primary LLM (text chat and streaming), text embeddings for semantic chapter search, and image generation.

| Config Key | Environment Variable |
|---|---|
| `foundry.endpoint` | `FOUNDRY_ENDPOINT` |
| `foundry.key` | `FOUNDRY_KEY` |
| `foundry.projectId` | `FOUNDRY_PROJECT_ID` |
| `foundry.embeddingModel` | `FOUNDRY_EMBEDDING_MODEL` |
| `foundry.miniModel` | `FOUNDRY_MINI_MODEL` |
| `foundry.fullModel` | `FOUNDRY_FULL_MODEL` |
| `foundry.imageGenerationEndpoint` | `FOUNDRY_IMAGE_GENERATION_ENDPOINT` |
| `foundry.imageGenerationKey` | `FOUNDRY_IMAGE_GENERATION_KEY` |
| `foundry.imageGenerationModel` | `FOUNDRY_IMAGE_GENERATION_MODEL` |

### Google Identity Services
Handles user authentication. Users sign in with their Google account; the server verifies the Google ID token and issues a short-lived custom JWT.

| Config Key | Environment Variable |
|---|---|
| `googleClientId` | `GOOGLE_CLIENT_ID` |

### JWT Secret
Used to sign and verify the custom session tokens issued after Google login.

| Config Key | Environment Variable |
|---|---|
| `jwtSecret` | `JWT_SECRET` |

---

## Local Development

### Prerequisites
- Node.js 20+
- An `_private/config.json` file populated with all the keys listed above (see `server/config.ts` for the full shape)

### Install dependencies

```bash
npm install
cd client && npm install
```

### Run in development mode

```bash
npm run dev
```

This starts the Express server (port 3200) and the Angular dev server (port 6258) concurrently. The Angular dev server proxies API requests to the Express server.

### Build for production

```bash
npm run build
```

Compiles the TypeScript server and builds the Angular client. The Express server then serves the compiled Angular app as static files.

---

## Deployment

The app is deployed to **Azure App Service** (app name: `quill-ai`) via a GitHub Actions workflow on every push to `master`. The workflow builds both the server and client, then deploys the full package using the `AZURE_WEBAPP_PUBLISH_PROFILE` repository secret.

All runtime secrets are configured as environment variables on the Azure App Service instance.

import fs from 'fs';
import path from 'path';

interface AppConfig {
  googleClientId: string;
  jwtSecret: string;
  cryptoKey: string;
  cosmosEndpoint: string;
  cosmosKey: string;
  cosmosDatabase: string;
  storageContainerName: string;
  storageAccountName: string;
  storageAccountKey: string;
  googleMapsApiKey: string;
  /**
   * Base URL of the external receiver that "Upload" on a gallery photo posts to
   * (see POST /api/upload/photo-export). Optional — the action reports itself as
   * unconfigured rather than failing at the network when this is unset.
   */
  photoExportUrl?: string;
  foundry: {
    projectId: string;
    endpoint: string;
    key: string;
    /** Azure OpenAI REST api-version used by every chat client. */
    apiVersion: string;
    embeddingModel: string;
    /**
     * The three chat tiers. Every completion picks one deliberately:
     * `low` for mechanical one-liners and latency-sensitive probes, `mid` for
     * interactive assistant turns and bounded structured work, `high` for
     * long-form prose and whole-chapter extraction where quality wins.
     */
    lowModel: string;
    midModel: string;
    highModel: string;
    imageGenerationEndpoint: string;
    imageGenerationKey: string;
    imageGenerationModel: string;
  };
  /** Google AI Studio (Gemini). Optional — features that use it degrade
   * gracefully when it isn't configured. */
  googleAIStudio?: {
    apiKey?: string;
    model?: string;
    /** Text model used for Google Search-grounded lookups. Must be a model that
     * supports the `google_search` tool; see GEMINI_SEARCH_MODEL_DEFAULT. */
    searchModel?: string;
  };
}

/**
 * Azure OpenAI api-version used when none is configured. The gpt-5.6 family is
 * only exposed from 2025-04-01-preview onward, so this must not be lowered
 * below that while those deployments are in use.
 */
export const FOUNDRY_API_VERSION_DEFAULT = '2025-04-01-preview';

function loadConfig(): AppConfig {
  const localPath = path.join(__dirname, '..', '_private', 'config.json');
  if (fs.existsSync(localPath)) {
    const local = JSON.parse(fs.readFileSync(localPath, 'utf-8')) as AppConfig;
    local.foundry.apiVersion ||= FOUNDRY_API_VERSION_DEFAULT;
    return local;
  }

  return {
    googleClientId: process.env['GOOGLE_CLIENT_ID']!,
    jwtSecret: process.env['JWT_SECRET']!,
    cryptoKey: process.env['CRYPTO_KEY']!,
    cosmosEndpoint: process.env['COSMOS_ENDPOINT']!,
    cosmosKey: process.env['COSMOS_KEY']!,
    cosmosDatabase: process.env['COSMOS_DATABASE']!,
    storageContainerName: process.env['STORAGE_CONTAINER_NAME']!,
    storageAccountName: process.env['STORAGE_ACCOUNT_NAME']!,
    storageAccountKey: process.env['STORAGE_ACCOUNT_KEY']!,
    googleMapsApiKey: process.env['GOOGLE_MAPS_API_KEY']!,
    photoExportUrl: process.env['PHOTO_EXPORT_URL'],
    foundry: {
      projectId: process.env['FOUNDRY_PROJECT_ID']!,
      endpoint: process.env['FOUNDRY_ENDPOINT']!,
      key: process.env['FOUNDRY_KEY']!,
      apiVersion: process.env['FOUNDRY_API_VERSION'] || FOUNDRY_API_VERSION_DEFAULT,
      embeddingModel: process.env['FOUNDRY_EMBEDDING_MODEL']!,
      lowModel: process.env['FOUNDRY_LOW_MODEL']!,
      midModel: process.env['FOUNDRY_MID_MODEL']!,
      highModel: process.env['FOUNDRY_HIGH_MODEL']!,
      imageGenerationEndpoint: process.env['FOUNDRY_IMAGE_GENERATION_ENDPOINT']!,
      imageGenerationKey: process.env['FOUNDRY_IMAGE_GENERATION_KEY']!,
      imageGenerationModel: process.env['FOUNDRY_IMAGE_GENERATION_MODEL']!,
    },
    googleAIStudio: {
      apiKey: process.env['GOOGLE_AI_STUDIO_API_KEY'],
      model: process.env['GOOGLE_AI_STUDIO_MODEL'],
      searchModel: process.env['GOOGLE_AI_STUDIO_SEARCH_MODEL'],
    },
  };
}

const config: AppConfig = loadConfig();
export default config;

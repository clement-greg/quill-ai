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
  foundry: {
    projectId: string;
    endpoint: string;
    key: string;
    embeddingModel: string;
    miniModel: string;
    fullModel: string;
    imageGenerationEndpoint: string;
    imageGenerationKey: string;
    imageGenerationModel: string;
  };
}

function loadConfig(): AppConfig {
  const localPath = path.join(__dirname, '..', '_private', 'config.json');
  if (fs.existsSync(localPath)) {
    return JSON.parse(fs.readFileSync(localPath, 'utf-8'));
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
    foundry: {
      projectId: process.env['FOUNDRY_PROJECT_ID']!,
      endpoint: process.env['FOUNDRY_ENDPOINT']!,
      key: process.env['FOUNDRY_KEY']!,
      embeddingModel: process.env['FOUNDRY_EMBEDDING_MODEL']!,
      miniModel: process.env['FOUNDRY_MINI_MODEL']!,
      fullModel: process.env['FOUNDRY_FULL_MODEL']!,
      imageGenerationEndpoint: process.env['FOUNDRY_IMAGE_GENERATION_ENDPOINT']!,
      imageGenerationKey: process.env['FOUNDRY_IMAGE_GENERATION_KEY']!,
      imageGenerationModel: process.env['FOUNDRY_IMAGE_GENERATION_MODEL']!,
    },
  };
}

const config: AppConfig = loadConfig();
export default config;

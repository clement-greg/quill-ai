/** Stub config used by Jest when tests import './config'. */
const config = {
  jwtSecret: 'test-secret',
  googleClientId: 'test-client-id',
  cosmosEndpoint: 'https://fake.cosmos.azure.com',
  cosmosKey: 'fake-key',
  cosmosDatabase: 'test-db',
  storageContainerName: 'test-container',
  storageAccountName: 'test-account',
  storageAccountKey: 'test-key',
  foundry: {
    projectId: '',
    endpoint: '',
    key: '',
    embeddingModel: '',
    miniModel: '',
    fullModel: '',
    imageGenerationEndpoint: '',
    imageGenerationKey: '',
    imageGenerationModel: '',
  },
};

export default config;

import directFileProvider from './directFileProvider.js';
import platformStubProvider from './platformStubProvider.js';

const providers = [directFileProvider, platformStubProvider];

export function findProvider(url) {
  return providers.find((provider) => provider.supports(url));
}

export async function getPlatformRuntimeStatus() {
  if (typeof platformStubProvider.getRuntimeStatus !== 'function') {
    return null;
  }
  return platformStubProvider.getRuntimeStatus();
}

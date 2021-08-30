const sinon = require('sinon');

export const sandbox = sinon.createSandbox();

/**
 * Context object
 */
export const context = {
  log: {
    info: sandbox.stub(),
    verbose: sandbox.stub(),
    error: sandbox.stub()
  },
  bindings: {}
};

/**
 * Mock environment variables
 */
export const mockEnv = {
  HecUrl: 'mock://hec:url',
  HecToken: 'mock_hec_token',
  SourceType: 'mock_sourcetype',
  Region: 'mock_region',
  // The namespace can contain only letters, numbers, and hyphens. The namespace must start with a
  // letter, and it must end with a letter or number.
  EventHubConnection: "key1=val;Endpoint=sb://Mock-0-Namespace1.servicebus.windows.net/;key2=v",
  // For testing purposes
  EventHubNamespace: "Mock-0-Namespace1",
  EventHubName: 'mock-eh-name',
  DataManagerInputId: 'mock-input-id',
  SPLUNK_BATCH_MAX_SIZE_BYTES: 1 * 1000 * 1000
};

const createEvent = (size: number): string => {
  return 'a'.repeat(size);
};

/**
 * Create the provided number of events of the given size
 */
export const createEvents = (count: number, size: number): String[] => {
  return new Array<String>(count).fill(createEvent(size));
};
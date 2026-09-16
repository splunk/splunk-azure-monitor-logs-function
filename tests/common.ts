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
  bindings: {},
  bindingData: {
    systemPropertiesArray: []
  }
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
  EventHubConnection__fullyQualifiedNamespace: "Mock-0-Namespace1.servicebus.windows.net",
  // For testing purposes
  EventHubNamespace: "Mock-0-Namespace1",
  EventHubName: 'mock-eh-name',
  DataManagerInputId: 'mock-input-id',
  SPLUNK_BATCH_MAX_SIZE_BYTES: 1 * 1000 * 1000,
  EnableEventhubMetadata: "false"
};

/**
 * Minimal fields satisfying the Azure Monitor log record schema (time, operationName,
 * category, resourceId) enforced in index.ts. Spread into test record fixtures that need
 * to pass schema validation; tests that only need to exercise the invalid/quarantine path
 * should NOT spread this in.
 */
export const validRecord = {
  time: '2019-01-21T22:14:26.9792776Z',
  resourceId: '/SUBSCRIPTIONS/dda8dfb6-5bbe-447a-ad40-3f50fd4cc4f3/RESOURCEGROUPS/SAMPLE-LOGS/PROVIDERS/MICROSOFT.NETWORK/BASTIONHOSTS/SAMPLE-LOGS-VNET-BASTION',
  operationName: 'Microsoft.Network/bastionHosts/write',
  category: 'Audit',
};

/**
 * Same as `validRecord`, but for tenant-level logs (e.g. AAD) which carry `tenantId`
 * instead of `resourceId` per the Azure Monitor schema.
 */
export const validTenantRecord = {
  time: '2019-01-21T22:14:26.9792776Z',
  tenantId: 'aaaabbbb-0000-cccc-1111-dddd2222eeee',
  operationName: 'Add user',
  category: 'AuditLogs',
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

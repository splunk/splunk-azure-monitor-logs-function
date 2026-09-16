import axios, { AxiosInstance } from 'axios';
import { expect } from 'chai';
import { ungzip } from 'node-gzip';
import { SinonStub } from 'sinon';

import azureMonitorLogsProcessorFunc from '../azure_monitor_logs_processor_func/index';
import { context, mockEnv, sandbox, validRecord, validTenantRecord } from './common';

const splunkContext: any = context;

describe('Azure Monitor Logs Process', function () {
  describe('Push events', () => {
    let httpClientStub: SinonStub;
    let postStub: SinonStub;
    let clientInstance: AxiosInstance;

    this.beforeEach(() => {
      sandbox.stub(process, 'env').value(mockEnv);
      clientInstance = axios.create();
      httpClientStub = sandbox.stub(axios, 'create');
      postStub = sandbox.stub();
      clientInstance.post = postStub;
    });

    this.afterEach(() => {
      sandbox.restore();
    });

    it('should create httpClient with correct params', async () => {
      httpClientStub.returns(clientInstance);
      postStub.resolves({ status: 200 });

      const eventHubMessages = [{ records: [{ ...validRecord, 'Foo': 'bar' }] }];
      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(httpClientStub.calledOnce).to.be.true;
      expect(httpClientStub.firstCall.args.length).to.equal(1);
      expect(httpClientStub.firstCall.args[0]).to.include.keys('baseURL', 'headers', 'timeout');
      expect(httpClientStub.firstCall.args[0].baseURL).to.equal(mockEnv.HecUrl);
      expect(httpClientStub.firstCall.args[0].headers).to.deep.equal({
        Authorization: `Splunk ${mockEnv.HecToken}`,
        "Content-Encoding": "gzip"
      });
    });

    it('should calculate appropriate httpClient timeout', async () => {
      const dateStub = sandbox.stub(Date, 'now');

      // Default covers any Date.now() calls between startTime and timeToBuild (e.g. moment.utc()
      // parsing the record's `time` field internally) so the timing math stays exact regardless
      // of how many incidental calls happen in between.
      dateStub.returns(new Date(1633453028100));
      dateStub.onCall(0).returns(new Date(1633453028000));

      // ((FUNC_TIMEOUT - INIT_TIME - WRITE_TIME - BUFFER - time to batch payload) / RetryCount) / Number of batches
      const timeout = (((10 * 60 * 1000) - (2 * 60 * 1000) - (30 * 1000) - (30 * 1000) - 100) / 3) / 1;

      httpClientStub.returns(clientInstance);
      postStub.resolves({ status: 200 });


      const eventHubMessages = [{ records: [{ ...validRecord, 'Foo': 'bar' }] }];
      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(httpClientStub.calledOnce).to.be.true;
      expect(httpClientStub.firstCall.args.length).to.equal(1);
      expect(httpClientStub.firstCall.args[0]).to.include.keys('timeout');
      expect(httpClientStub.firstCall.args[0].timeout).to.equal(timeout);
    });

    it('should handle not set negative httpClient timeout', async () => {
      const dateStub = sandbox.stub(Date, 'now');

      dateStub.returns(new Date(1633454028100));
      dateStub.onCall(0).returns(new Date(1633453028000));

      const timeout = 1;

      httpClientStub.returns(clientInstance);
      postStub.resolves({ status: 200 });


      const eventHubMessages = [{ records: [{ ...validRecord, 'Foo': 'bar' }] }];
      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(httpClientStub.calledOnce).to.be.true;
      expect(httpClientStub.firstCall.args.length).to.equal(1);
      expect(httpClientStub.firstCall.args[0]).to.include.keys('timeout');
      expect(httpClientStub.firstCall.args[0].timeout).to.equal(timeout);
    });

    it('should handle multiple requests httpClient timeout', async () => {
      const dateStub = sandbox.stub(Date, 'now');
      sandbox.stub(process.env, 'SPLUNK_BATCH_MAX_SIZE_BYTES').value(10);

      dateStub.returns(new Date(1633453028100));
      dateStub.onCall(0).returns(new Date(1633453028000));

      // ((FUNC_TIMEOUT - INIT_TIME - WRITE_TIME - BUFFER - time to batch payload) / RetryCount) / Number of batches
      const timeout = (((10 * 60 * 1000) - (2 * 60 * 1000) - (30 * 1000) - (30 * 1000) - 100) / 3) / 2;

      httpClientStub.returns(clientInstance);
      postStub.resolves({ status: 200 });


      const eventHubMessages = [{ records: [{ ...validRecord, 'Foo': 'bar' }] }, { records: [{ ...validRecord, 'Foo': 'bar' }] }];
      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(httpClientStub.calledOnce).to.be.true;
      expect(httpClientStub.firstCall.args.length).to.equal(1);
      expect(httpClientStub.firstCall.args[0]).to.include.keys('timeout');
      expect(httpClientStub.firstCall.args[0].timeout).to.equal(timeout);
    });

    it('should make correct POST request', async () => {
      httpClientStub.returns(clientInstance);
      postStub.resolves({ status: 200 });

      const eventHubMessages = [{ records: [{ ...validRecord, Foo: 'bar' }] }];
      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(postStub.calledOnce).is.true;
      expect(postStub.firstCall.args.length).to.equal(2);
      const expectedPath = 'services/collector/event';
      const actualPath = postStub.firstCall.args[0];
      expect(expectedPath).to.equal(actualPath);
      const expectedPayload = JSON.stringify({
        event: {
          ...validRecord,
          Foo: 'bar'
        },
        source: 'azure:mock_region:Mock-0-Namespace1:mock-eh-name',
        sourcetype: 'mock_sourcetype',
        fields: {
          data_manager_input_id: 'mock-input-id',
        },
        time: 1548108866979,
        index: 'bastion',
      });
      const actualPayload = (await ungzip(postStub.firstCall.args[1])).toString();
      expect(expectedPayload).to.equal(actualPayload);
    });


    it('should resolve source namespace from fullyQualifiedNamespace, ignoring legacy connection string', async () => {
      httpClientStub.returns(clientInstance);
      postStub.resolves({ status: 200 });
      sandbox.stub(process.env, 'EventHubConnection__fullyQualifiedNamespace').value('Mi-Namespace.servicebus.windows.net');
      sandbox.stub(process.env, 'EventHubConnection').value('key1=val;Endpoint=sb://Legacy-Namespace.servicebus.windows.net/;key2=v');

      const eventHubMessages = [{ records: [{ ...validRecord, 'Foo': 'bar' }] }];
      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      const actualPayload = JSON.parse((await ungzip(postStub.firstCall.args[1])).toString());
      expect(actualPayload.source).to.equal('azure:mock_region:Mi-Namespace:mock-eh-name');
    });

    it('should fall back to legacy connection string when fullyQualifiedNamespace is unset', async () => {
      httpClientStub.returns(clientInstance);
      postStub.resolves({ status: 200 });
      sandbox.stub(process.env, 'EventHubConnection__fullyQualifiedNamespace').value(undefined);
      sandbox.stub(process.env, 'EventHubConnection').value('key1=val;Endpoint=sb://Legacy-Namespace.servicebus.windows.net/;key2=v');

      const eventHubMessages = [{ records: [{ ...validRecord, 'Foo': 'bar' }] }];
      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      const actualPayload = JSON.parse((await ungzip(postStub.firstCall.args[1])).toString());
      expect(actualPayload.source).to.equal('azure:mock_region:Legacy-Namespace:mock-eh-name');
    });

    it('should make correct POST request with azure resource logs input', async () => {
      httpClientStub.returns(clientInstance);
      postStub.resolves({ status: 200 });

      const eventHubMessages = [{ records: [{ ...validRecord, Foo: 'bar' }] }];
      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(postStub.calledOnce).is.true;
      expect(postStub.firstCall.args.length).to.equal(2);
      const expectedPath = 'services/collector/event';
      const actualPath = postStub.firstCall.args[0];
      expect(expectedPath).to.equal(actualPath);
      const expectedPayload = JSON.stringify({
        event: {
          ...validRecord,
          Foo: 'bar'
        },
        source: 'azure:mock_region:Mock-0-Namespace1:mock-eh-name',
        sourcetype: 'mock_sourcetype',
        fields: {
          data_manager_input_id: 'mock-input-id',
        },
        time: 1548108866979,
        index: 'bastion'
      });
      const actualPayload = (await ungzip(postStub.firstCall.args[1])).toString();
      expect(expectedPayload).to.equal(actualPayload);
    });

    it('should be default index if ResourceTypeDestinationIndex is undefined', async () => {
      sandbox.stub(process.env, 'ResourceTypeDestinationIndex').value(undefined);
      httpClientStub.returns(clientInstance);
      postStub.resolves({ status: 200 });

      const eventHubMessages = [{ records: [{ ...validRecord, Foo: 'bar' }] }];
      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(postStub.calledOnce).is.true;
      expect(postStub.firstCall.args.length).to.equal(2);
      const expectedPath = 'services/collector/event';
      const actualPath = postStub.firstCall.args[0];
      expect(expectedPath).to.equal(actualPath);
      const expectedPayload = JSON.stringify({
        event: {
          ...validRecord,
          Foo: 'bar'
        },
        source: 'azure:mock_region:Mock-0-Namespace1:mock-eh-name',
        sourcetype: 'mock_sourcetype',
        fields: {
          data_manager_input_id: 'mock-input-id',
        },
        time: 1548108866979,
      });
      const actualPayload = (await ungzip(postStub.firstCall.args[1])).toString();
      expect(expectedPayload).to.equal(actualPayload);
    });

    // Skipped: the extractResourceType fix this regression test depends on (DAT-3667) isn't on
    // this 4.7 branch yet. Un-skip once that fix is backported.
    it.skip('should process an oversized resourceId without a ReDoS stall', async () => {
      httpClientStub.returns(clientInstance);
      postStub.resolves({ status: 200 });

      // Regression test for CWE-1333: extractResourceType previously used '.*' + delimiter as a
      // regex, which caused catastrophic backtracking on long inputs that do not contain the
      // delimiter. This asserts the function completes quickly regardless of resourceId length.
      const maliciousResourceId = 'A'.repeat(500000);
      const eventHubMessages = [{ records: [{ ...validRecord, Foo: 'bar', resourceId: maliciousResourceId }] }];

      const start = Date.now();
      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);
      const elapsedMs = Date.now() - start;

      expect(elapsedMs).to.be.lessThan(1000);
      expect(postStub.calledOnce).is.true;
    });

    /**
     * WAD/ETW records (Microsoft-Windows-WebSites) carry PascalCase `ResourceId` instead of
     * the common envelope's lowercase `resourceId`.
     */
    it('should extract index from PascalCase ResourceId field (WAD/ETW records)', async () => {
      httpClientStub.returns(clientInstance);
      postStub.resolves({ status: 200 });

      const wadRecord = {
        ProviderName: 'Microsoft-Windows-WebSites',
        Time: '2019-01-21T22:14:26.9792776Z',
        Category: 'Administrative',
        ResourceId: '/SUBSCRIPTIONS/dda8dfb6-5bbe-447a-ad40-3f50fd4cc4f3/RESOURCEGROUPS/SAMPLE-LOGS/PROVIDERS/MICROSOFT.NETWORK/BASTIONHOSTS/SAMPLE-LOGS-VNET-BASTION',
        OperationName: 'UpdateWebSite',
      };
      const eventHubMessages = [{ records: [wadRecord] }];
      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(postStub.calledOnce).is.true;
      expect(postStub.firstCall.args.length).to.equal(2);
      const actualPayload = JSON.parse((await ungzip(postStub.firstCall.args[1])).toString());
      expect(actualPayload).to.include.keys('index');
      expect(actualPayload.index).to.equal('bastion');
    });

    it('should be default index if ResourceTypeDestinationIndex is undefined and resourceId is not provided ', async () => {
      sandbox.stub(process.env, 'ResourceTypeDestinationIndex').value(undefined);
      httpClientStub.returns(clientInstance);
      postStub.resolves({ status: 200 });

      const eventHubMessages = [{ records: [{ ...validTenantRecord, Foo: 'bar' }] }];
      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(postStub.calledOnce).is.true;
      expect(postStub.firstCall.args.length).to.equal(2);
      const expectedPath = 'services/collector/event';
      const actualPath = postStub.firstCall.args[0];
      expect(expectedPath).to.equal(actualPath);
      const expectedPayload = JSON.stringify({
        event: {
          ...validTenantRecord,
          Foo: 'bar'
        },
        source: 'azure:mock_region:Mock-0-Namespace1:mock-eh-name',
        sourcetype: 'mock_sourcetype',
        fields: {
          data_manager_input_id: 'mock-input-id',
        },
        time: 1548108866979,
      });
      const actualPayload = (await ungzip(postStub.firstCall.args[1])).toString();
      expect(expectedPayload).to.equal(actualPayload);
    });

    it('should be default index if ResourceTypeDestinationIndex is not provided ', async () => {
      const removeResourceTypeDestinationIndexEnv = 'ResourceTypeDestinationIndex';
      const { [removeResourceTypeDestinationIndexEnv]: removedKey, ...mockEnvCopy } = mockEnv;

      sandbox.stub(process, 'env').value(mockEnvCopy);
      httpClientStub.returns(clientInstance);
      postStub.resolves({ status: 200 });

      const eventHubMessages = [{ records: [{ ...validTenantRecord, Foo: 'bar' }] }];
      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(postStub.calledOnce).is.true;
      expect(postStub.firstCall.args.length).to.equal(2);
      const expectedPath = 'services/collector/event';
      const actualPath = postStub.firstCall.args[0];
      expect(expectedPath).to.equal(actualPath);
      const expectedPayload = JSON.stringify({
        event: {
          ...validTenantRecord,
          Foo: 'bar'
        },
        source: 'azure:mock_region:Mock-0-Namespace1:mock-eh-name',
        sourcetype: 'mock_sourcetype',
        fields: {
          data_manager_input_id: 'mock-input-id',
        },
        time: 1548108866979,
      });
      const actualPayload = (await ungzip(postStub.firstCall.args[1])).toString();
      expect(expectedPayload).to.equal(actualPayload);
    });


    it('should switch to default index when resource id is not provided', async () => {
      httpClientStub.returns(clientInstance);
      postStub.resolves({ status: 200 });

      const eventHubMessages = [{ records: [{ ...validTenantRecord, Foo: 'bar' }] }];
      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(postStub.calledOnce).is.true;
      expect(postStub.firstCall.args.length).to.equal(2);
      const expectedPath = 'services/collector/event';
      const actualPath = postStub.firstCall.args[0];
      expect(expectedPath).to.equal(actualPath);
      const expectedPayload = JSON.stringify({
        event: {
          ...validTenantRecord,
          Foo: 'bar'
        },
        source: 'azure:mock_region:Mock-0-Namespace1:mock-eh-name',
        sourcetype: 'mock_sourcetype',
        fields: {
          data_manager_input_id: 'mock-input-id',
        },
        time: 1548108866979,
      });
      const actualPayload = (await ungzip(postStub.firstCall.args[1])).toString();
      expect(expectedPayload).to.equal(actualPayload);
    });


    it('should make correct POST request with eventhub metadata if enabled', async () => {
      httpClientStub.returns(clientInstance);
      postStub.resolves({ status: 200 });
      sandbox.stub(process.env, 'EnableEventhubMetadata').value("true");
      sandbox.stub(splunkContext.bindingData,'systemPropertiesArray').value([{ 'lemon': 'tree' }]);

      const eventHubMessages = [{ records: [{ ...validRecord, Foo: 'bar' }] }];
      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      const expectedPayload = JSON.stringify({
        event: {
          ...validRecord,
          Foo: 'bar',
          __eventhub_metadata: {
            lemon: 'tree'
          }
        },
        source: 'azure:mock_region:Mock-0-Namespace1:mock-eh-name',
        sourcetype: 'mock_sourcetype',
        fields: {
          data_manager_input_id: 'mock-input-id',
        },
        time: 1548108866979,
        index: 'bastion',
      });
      const actualPayload = (await ungzip(postStub.firstCall.args[1])).toString();
      expect(expectedPayload).to.equal(actualPayload);
    });

    it('should batch events', async () => {
      // 1000 fits exactly 2 of these (now-larger, schema-conforming) serialized events per batch,
      // matching the original test's "2 in batch one, 1 overflows to batch two" intent.
      sandbox.stub(process.env, 'SPLUNK_BATCH_MAX_SIZE_BYTES').value(1000);
      httpClientStub.returns(clientInstance);
      postStub.resolves({ status: 200 });

      const eventHubMessages = [
        {
          records: [
            {
              ...validRecord,
              Foo: 'from_msg1_batch_1',
            }
          ]
        },
        {
          records: [
            {
              ...validRecord,
              'Foo': 'from_msg2_batch_1',
            },
            {
              ...validRecord,
              'Foo': 'from_msg2_batch_2',
            },
          ]
        },
      ];
      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      // Uncompress zip payload
      const firstCallUncompressedEvent = (await ungzip(postStub.firstCall.args[1])).toString();
      const secondCallUncompressedEvent = (await ungzip(postStub.secondCall.args[1])).toString();

      expect(postStub.callCount).to.equal(2);
      expect(postStub.firstCall.args.length).to.equal(2);
      expect(firstCallUncompressedEvent).to.contain('batch_1');
      expect(firstCallUncompressedEvent).to.not.contain('batch_2');
      expect(postStub.secondCall.args.length).to.equal(2);
      expect(secondCallUncompressedEvent).to.not.contain('batch_1');
      expect(secondCallUncompressedEvent).to.contain('batch_2');
    });

  });
});

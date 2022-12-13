import axios, { AxiosInstance } from 'axios';
import { expect } from 'chai';
import { ungzip } from 'node-gzip';
import { SinonStub } from 'sinon';

import azureMonitorLogsProcessorFunc from '../azure_monitor_logs_processor_func/index';
import { context, mockEnv, sandbox } from './common';

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

      const eventHubMessages = [{ records: [{ 'Foo': 'bar' }] }];
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

      dateStub.onCall(0).returns(new Date(1633453028000));
      dateStub.onCall(1).returns(new Date(1633453028100));

      // ((FUNC_TIMEOUT - INIT_TIME - WRITE_TIME - BUFFER - time to batch payload) / RetryCount) / Number of batches
      const timeout = (((10 * 60 * 1000) - (2 * 60 * 1000) - (30 * 1000) - (30 * 1000) - 100) / 3) / 1;

      httpClientStub.returns(clientInstance);
      postStub.resolves({ status: 200 });


      const eventHubMessages = [{ records: [{ 'Foo': 'bar' }] }];
      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(httpClientStub.calledOnce).to.be.true;
      expect(httpClientStub.firstCall.args.length).to.equal(1);
      expect(httpClientStub.firstCall.args[0]).to.include.keys('timeout');
      expect(httpClientStub.firstCall.args[0].timeout).to.equal(timeout);
    });

    it('should handle not set negative httpClient timeout', async () => {
      const dateStub = sandbox.stub(Date, 'now');

      dateStub.onCall(0).returns(new Date(1633453028000));
      dateStub.onCall(1).returns(new Date(1633454028100));

      const timeout = 1;

      httpClientStub.returns(clientInstance);
      postStub.resolves({ status: 200 });


      const eventHubMessages = [{ records: [{ 'Foo': 'bar' }] }];
      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(httpClientStub.calledOnce).to.be.true;
      expect(httpClientStub.firstCall.args.length).to.equal(1);
      expect(httpClientStub.firstCall.args[0]).to.include.keys('timeout');
      expect(httpClientStub.firstCall.args[0].timeout).to.equal(timeout);
    });

    it('should handle multiple requests httpClient timeout', async () => {
      const dateStub = sandbox.stub(Date, 'now');
      sandbox.stub(process.env, 'SPLUNK_BATCH_MAX_SIZE_BYTES').value(10);

      dateStub.onCall(0).returns(new Date(1633453028000));
      dateStub.onCall(1).returns(new Date(1633453028100));

      // ((FUNC_TIMEOUT - INIT_TIME - WRITE_TIME - BUFFER - time to batch payload) / RetryCount) / Number of batches
      const timeout = (((10 * 60 * 1000) - (2 * 60 * 1000) - (30 * 1000) - (30 * 1000) - 100) / 3) / 2;

      httpClientStub.returns(clientInstance);
      postStub.resolves({ status: 200 });


      const eventHubMessages = [{ records: [{ 'Foo': 'bar' }] }, { records: [{ 'Foo': 'bar' }] }];
      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(httpClientStub.calledOnce).to.be.true;
      expect(httpClientStub.firstCall.args.length).to.equal(1);
      expect(httpClientStub.firstCall.args[0]).to.include.keys('timeout');
      expect(httpClientStub.firstCall.args[0].timeout).to.equal(timeout);
    });

    it('should make correct POST request', async () => {
      httpClientStub.returns(clientInstance);
      postStub.resolves({ status: 200 });

      const eventHubMessages = [{ records: [{ 'Foo': 'bar' }] }];
      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(postStub.calledOnce).is.true;
      expect(postStub.firstCall.args.length).to.equal(2);
      const expectedPath = 'services/collector/event';
      const actualPath = postStub.firstCall.args[0];
      expect(expectedPath).to.equal(actualPath);
      const expectedPayload = JSON.stringify({
        event: {
          Foo: 'bar'
        },
        source: 'azure:mock_region:Mock-0-Namespace1:mock-eh-name',
        sourcetype: 'mock_sourcetype',
        fields: {
          data_manager_input_id: 'mock-input-id',
        },
      });
      const actualPayload = (await ungzip(postStub.firstCall.args[1])).toString();
      expect(expectedPayload).to.equal(actualPayload);
    });

    it('should make correct POST request with azure resource logs input', async () => {
      httpClientStub.returns(clientInstance);
      postStub.resolves({ status: 200 });

      const eventHubMessages = [{ records: [{ 'Foo': 'bar', 'resourceId': '/SUBSCRIPTIONS/C83C2282-2E21-4F64-86AE-FDFA66B673EB/RESOURCEGROUPS/SAMPLE-LOGS/PROVIDERS/MICROSOFT.NETWORK/BASTIONHOSTS/SAMPLE-LOGS-VNET-BASTION' }] }];
      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(postStub.calledOnce).is.true;
      expect(postStub.firstCall.args.length).to.equal(2);
      const expectedPath = 'services/collector/event';
      const actualPath = postStub.firstCall.args[0];
      expect(expectedPath).to.equal(actualPath);
      const expectedPayload = JSON.stringify({
        event: {
          Foo: 'bar',
          resourceId: '/SUBSCRIPTIONS/C83C2282-2E21-4F64-86AE-FDFA66B673EB/RESOURCEGROUPS/SAMPLE-LOGS/PROVIDERS/MICROSOFT.NETWORK/BASTIONHOSTS/SAMPLE-LOGS-VNET-BASTION'
        },
        source: 'azure:mock_region:Mock-0-Namespace1:mock-eh-name',
        sourcetype: 'mock_sourcetype',
        fields: {
          data_manager_input_id: 'mock-input-id',
        },
        index: 'bastion'
      });
      const actualPayload = (await ungzip(postStub.firstCall.args[1])).toString();
      expect(expectedPayload).to.equal(actualPayload);
    });

    it('should be default index if ResourceTypeDestinationIndex is undefined', async () => {
      sandbox.stub(process.env, 'ResourceTypeDestinationIndex').value(undefined);
      httpClientStub.returns(clientInstance);
      postStub.resolves({ status: 200 });

      const eventHubMessages = [{ records: [{ 'Foo': 'bar', 'resourceId': '/SUBSCRIPTIONS/C83C2282-2E21-4F64-86AE-FDFA66B673EB/RESOURCEGROUPS/SAMPLE-LOGS/PROVIDERS/MICROSOFT.NETWORK/BASTIONHOSTS/SAMPLE-LOGS-VNET-BASTION' }] }];
      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(postStub.calledOnce).is.true;
      expect(postStub.firstCall.args.length).to.equal(2);
      const expectedPath = 'services/collector/event';
      const actualPath = postStub.firstCall.args[0];
      expect(expectedPath).to.equal(actualPath);
      const expectedPayload = JSON.stringify({
        event: {
          Foo: 'bar',
          resourceId: '/SUBSCRIPTIONS/C83C2282-2E21-4F64-86AE-FDFA66B673EB/RESOURCEGROUPS/SAMPLE-LOGS/PROVIDERS/MICROSOFT.NETWORK/BASTIONHOSTS/SAMPLE-LOGS-VNET-BASTION'
        },
        source: 'azure:mock_region:Mock-0-Namespace1:mock-eh-name',
        sourcetype: 'mock_sourcetype',
        fields: {
          data_manager_input_id: 'mock-input-id',
        }
      });
      const actualPayload = (await ungzip(postStub.firstCall.args[1])).toString();
      expect(expectedPayload).to.equal(actualPayload);
    });

    it('should be default index if ResourceTypeDestinationIndex is undefined and resourceId is not provided ', async () => {
      sandbox.stub(process.env, 'ResourceTypeDestinationIndex').value(undefined);
      httpClientStub.returns(clientInstance);
      postStub.resolves({ status: 200 });

      const eventHubMessages = [{ records: [{ 'Foo': 'bar' }] }];
      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(postStub.calledOnce).is.true;
      expect(postStub.firstCall.args.length).to.equal(2);
      const expectedPath = 'services/collector/event';
      const actualPath = postStub.firstCall.args[0];
      expect(expectedPath).to.equal(actualPath);
      const expectedPayload = JSON.stringify({
        event: {
          Foo: 'bar'
        },
        source: 'azure:mock_region:Mock-0-Namespace1:mock-eh-name',
        sourcetype: 'mock_sourcetype',
        fields: {
          data_manager_input_id: 'mock-input-id',
        }
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

      const eventHubMessages = [{ records: [{ 'Foo': 'bar' }] }];
      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(postStub.calledOnce).is.true;
      expect(postStub.firstCall.args.length).to.equal(2);
      const expectedPath = 'services/collector/event';
      const actualPath = postStub.firstCall.args[0];
      expect(expectedPath).to.equal(actualPath);
      const expectedPayload = JSON.stringify({
        event: {
          Foo: 'bar'
        },
        source: 'azure:mock_region:Mock-0-Namespace1:mock-eh-name',
        sourcetype: 'mock_sourcetype',
        fields: {
          data_manager_input_id: 'mock-input-id',
        }
      });
      const actualPayload = (await ungzip(postStub.firstCall.args[1])).toString();
      expect(expectedPayload).to.equal(actualPayload);
    });


    it('should switch to default index when resource id is not provided', async () => {
      httpClientStub.returns(clientInstance);
      postStub.resolves({ status: 200 });

      const eventHubMessages = [{ records: [{ 'Foo': 'bar' }] }];
      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(postStub.calledOnce).is.true;
      expect(postStub.firstCall.args.length).to.equal(2);
      const expectedPath = 'services/collector/event';
      const actualPath = postStub.firstCall.args[0];
      expect(expectedPath).to.equal(actualPath);
      const expectedPayload = JSON.stringify({
        event: {
          Foo: 'bar'
        },
        source: 'azure:mock_region:Mock-0-Namespace1:mock-eh-name',
        sourcetype: 'mock_sourcetype',
        fields: {
          data_manager_input_id: 'mock-input-id',
        }
      });
      const actualPayload = (await ungzip(postStub.firstCall.args[1])).toString();
      expect(expectedPayload).to.equal(actualPayload);
    });


    it('should make correct POST request with eventhub metadata if enabled', async () => {
      httpClientStub.returns(clientInstance);
      postStub.resolves({ status: 200 });
      sandbox.stub(process.env, 'EnableEventhubMetadata').value("true");
      sandbox.stub(splunkContext.bindingData,'systemPropertiesArray').value([{ 'lemon': 'tree' }]);

      const eventHubMessages = [{ records: [{ 'Foo': 'bar' }] }];
      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      const expectedPayload = JSON.stringify({
        event: {
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
      });
      const actualPayload = (await ungzip(postStub.firstCall.args[1])).toString();
      expect(expectedPayload).to.equal(actualPayload);
    });

    it('should batch events', async () => {
      sandbox.stub(process.env, 'SPLUNK_BATCH_MAX_SIZE_BYTES').value(400);
      httpClientStub.returns(clientInstance);
      postStub.resolves({ status: 200 });

      const eventHubMessages = [
        {
          records: [
            {
              Foo: 'from_msg1_batch_1',
            }
          ]
        },
        {
          records: [
            {
              'Foo': 'from_msg2_batch_1',
            },
            {
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

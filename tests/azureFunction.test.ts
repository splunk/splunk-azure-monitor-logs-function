import axios from 'axios';
import { expect } from 'chai';
import { SinonStub } from 'sinon';

import azureMonitorLogsProcessorFunc from '../azure_monitor_logs_processor_func/index';
import { context, mockEnv, sandbox } from './common';

const splunkContext: any = context;

describe('Azure Monitor Logs Process', function () {
  describe('Push events', () => {
    let httpClientStub: SinonStub;
    let postStub: SinonStub;

    this.beforeEach(() => {
      httpClientStub = sandbox.stub(axios, 'create');
      postStub = sandbox.stub();
      sandbox.stub(process, 'env').value(mockEnv);
    });

    this.afterEach(() => {
      sandbox.restore();
    });

    it('should create httpClient with correct params', async () => {
      httpClientStub.returns({
        post: postStub
      })
      postStub.resolves({
        status: 200
      })
      const eventHubMessages = [{ records: [{ 'Foo': 'bar' }] }];
      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(httpClientStub.calledOnce).to.be.true;
      expect(httpClientStub.firstCall.args.length).to.equal(1);
      expect(httpClientStub.firstCall.args[0]).to.include.keys('baseURL', 'headers');
      expect(httpClientStub.firstCall.args[0].baseURL).to.equal(mockEnv.HecUrl);
      expect(httpClientStub.firstCall.args[0].headers).to.deep.equal({
        Authorization: `Splunk ${mockEnv.HecToken}`
      });
    });

    it('should make correct POST request', async () => {
      httpClientStub.returns({ post: postStub });
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
          Foo: 'bar',
        },
        source: 'azure:mock_region:Mock-0-Namespace1:mock-eh-name',
        sourcetype: 'mock_sourcetype',
        fields: {
          data_manager_input_id: 'mock-input-id',
        },
      });
      const actualPayload = postStub.firstCall.args[1];
      expect(expectedPayload).to.equal(actualPayload);
    });

    it('should batch events', async () => {
      sandbox.stub(process.env, 'SPLUNK_BATCH_MAX_SIZE_BYTES').value(400);
      httpClientStub.returns({ post: postStub });
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

      expect(postStub.callCount).to.equal(2);
      expect(postStub.firstCall.args.length).to.equal(2);
      expect(postStub.firstCall.args[1]).to.contain('batch_1');
      expect(postStub.firstCall.args[1]).to.not.contain('batch_2');
      expect(postStub.secondCall.args.length).to.equal(2);
      expect(postStub.secondCall.args[1]).to.not.contain('batch_1');
      expect(postStub.secondCall.args[1]).to.contain('batch_2');
    });
  });
});
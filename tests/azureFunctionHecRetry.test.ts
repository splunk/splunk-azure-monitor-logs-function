import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { expect } from 'chai';
import { SinonSpy, SinonStub } from 'sinon';
import * as nock from 'nock';

import azureMonitorLogsProcessorFunc from '../azure_monitor_logs_processor_func/index';
import { context, mockEnv, sandbox } from './common';

const splunkContext: any = context;

describe('Azure Monitor Logs Process', function () {
    describe('HEC Retries', () => {
        let httpClientStub: SinonStub;
        let requestSpy: SinonSpy;
        let clientInstance: AxiosInstance;

        this.beforeEach(() => {
            nock.cleanAll()
            clientInstance = axios.create({
                baseURL: 'http://example.com'
            });
            requestSpy = sandbox.spy((request: AxiosRequestConfig) => { return request });
            // Interceptor method on axios instance is used to determine how many requests (with args) are made
            clientInstance.interceptors.request.use(requestSpy);
            httpClientStub = sandbox.stub(axios, 'create');
            sandbox.stub(process, 'env').value(mockEnv);
            splunkContext.bindings = {};
        });

        this.afterEach(() => {
            sandbox.restore();
        });


        it('should retry hec call on 5xx failure', async () => {
            httpClientStub.returns(clientInstance);
            const scope = nock('http://example.com')
                .persist()
                .post('/services/collector/event')
                .reply(500, {});

            const eventHubMessages = [{ records: [{ 'Foo': 'bar' }] }];
            await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

            expect(requestSpy.callCount).to.equal(3);
            expect(requestSpy.firstCall.args.length).to.equal(1);
            expect(requestSpy.secondCall.args.length).to.equal(1);
            const firstConfig = requestSpy.firstCall.args[1];
            const secondConfig = requestSpy.secondCall.args[1];

            expect(firstConfig).to.deep.equal(secondConfig);
        });

        it('should retry hec call on network failure', async () => {
            httpClientStub.returns(clientInstance);
            const scope = nock('http://example.com')
                .persist()
                .post('/services/collector/event')
                .replyWithError({
                    message: "an error occured",
                    code: "ENOTFOUND"
                });

            const eventHubMessages = [{ records: [{ 'Foo': 'bar' }] }];
            await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

            expect(requestSpy.callCount).to.equal(3);
            expect(requestSpy.firstCall.args.length).to.equal(1);
            expect(requestSpy.secondCall.args.length).to.equal(1);
            const firstConfig = requestSpy.firstCall.args[1];
            const secondConfig = requestSpy.secondCall.args[1];

            expect(firstConfig).to.deep.equal(secondConfig);
        });

        it('should retry hec call on throttling error', async () => {
            httpClientStub.returns(clientInstance);
            nock('http://example.com')
                .persist()
                .post('/services/collector/event')
                .reply(429);

            const eventHubMessages = [{ records: [{ 'Foo': 'bar' }] }];
            await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

            expect(requestSpy.callCount).to.equal(3);
        });

        it('should retry hec call on hec request timeout error', async () => {
            httpClientStub.returns(clientInstance);
            nock('http://example.com')
                .persist()
                .post('/services/collector/event')
                .reply(429);

            const eventHubMessages = [{ records: [{ 'Foo': 'bar' }] }];
            await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

            expect(requestSpy.callCount).to.equal(3);
        });

        it('should not retry hec call on successful request', async () => {
            httpClientStub.returns(clientInstance);
            nock('http://example.com')
                .persist()
                .post('/services/collector/event')
                .reply(200);

            const eventHubMessages = [{ records: [{ 'Foo': 'bar' }] }];
            await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

            expect(requestSpy.callCount).to.equal(1);
        });

        it('should not retry hec call on a general 4xx error', async () => {
            httpClientStub.returns(clientInstance);
            nock('http://example.com')
                .persist()
                .post('/services/collector/event')
                .reply(400);

            const eventHubMessages = [{ records: [{ 'Foo': 'bar' }] }];
            await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

            expect(requestSpy.callCount).to.equal(1);
        });

        it('should not retry hec call on a greater than 5xx error', async () => {
            httpClientStub.returns(clientInstance);
            nock('http://example.com')
                .persist()
                .post('/services/collector/event')
                .reply(600);

            const eventHubMessages = [{ records: [{ 'Foo': 'bar' }] }];
            await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

            expect(requestSpy.callCount).to.equal(1);
        });

        it('should stop retrying hec call on successful request', async () => {
            httpClientStub.returns(clientInstance);
            nock('http://example.com')
                .post('/services/collector/event')
                .replyWithError({
                    message: "an error occured",
                    code: "ENOTFOUND"
                });

            nock('http://example.com')
                .post('/services/collector/event')
                .reply(200);

            const eventHubMessages = [{ records: [{ 'Foo': 'bar' }] }];
            await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

            expect(requestSpy.callCount).to.equal(2);
        });
    });
});
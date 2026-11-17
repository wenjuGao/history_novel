import assert from 'node:assert/strict';
import {resolveBailianEndpoint as resolve,billingMode} from '../src/lib/bailian-endpoint.mjs';
assert.equal(resolve('https://token-plan.cn-beijing.maas.aliyuncs.com'),'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1');
assert.equal(billingMode('https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'),'token-plan');
assert.equal(billingMode(), 'pay-as-you-go');
assert.equal(resolve('https://llm-example.cn-beijing.maas.aliyuncs.com/'),'https://llm-example.cn-beijing.maas.aliyuncs.com/compatible-mode/v1');
for(const value of ['https://token-plan.cn-beijing.maas.aliyuncs.com.evil.test','http://token-plan.cn-beijing.maas.aliyuncs.com','https://user:secret@token-plan.cn-beijing.maas.aliyuncs.com','https://token-plan.cn-beijing.maas.aliyuncs.com?key=secret','https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1'])assert.throws(()=>resolve(value));
console.log('PASS: Token Plan, pay-as-you-go, workspace, normalization, unsafe endpoint rejection.');

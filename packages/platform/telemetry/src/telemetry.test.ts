import { describe, expect, it } from 'vitest';
import { shutdownTelemetry, startTelemetry } from './index.js';

describe('startTelemetry', () => {
  it('stays off without a collector endpoint', async () => {
    const telemetry = startTelemetry({ serviceName: 'test', env: {} });
    expect(telemetry.enabled).toBe(false);
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
  });

  it('can be switched off explicitly', () => {
    const telemetry = startTelemetry({
      serviceName: 'test',
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1', OTEL_SDK_DISABLED: 'true' },
    });
    expect(telemetry.enabled).toBe(false);
  });

  it('starts once with an endpoint and shuts down cleanly', async () => {
    const env = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1', NODE_ENV: 'test' };
    const telemetry = startTelemetry({ serviceName: 'test', env });
    expect(telemetry.enabled).toBe(true);
    expect(startTelemetry({ serviceName: 'other', env })).toBe(telemetry);
    await shutdownTelemetry();
  });
});

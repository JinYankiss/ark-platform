/**
 * 官方示例改写 T01：OpenTelemetry NodeTracerProvider + OTLPTraceExporter README。
 * 来源动机 G07/A05；实现使用 OTel 官方包，不把 Copilot 的 context callback 当作完整 tracer。
 * 手动 span，默认不采集内容；不声称已经部署真实 Collector。
 */
import { ROOT_CONTEXT, SpanStatusCode, trace, type Attributes } from "@opentelemetry/api";
import { NodeTracerProvider, BatchSpanProcessor, SimpleSpanProcessor, type SpanExporter } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

export class Telemetry {
  private readonly provider?: NodeTracerProvider;
  constructor(endpoint?: string, exporter?: SpanExporter) {
    if (endpoint || exporter) this.provider = new NodeTracerProvider({
      spanProcessors: exporter ? [new SimpleSpanProcessor(exporter)] :
        [new BatchSpanProcessor(new OTLPTraceExporter({ url: endpoint }), { maxQueueSize: 1024 })],
    });
  }
  async traced<T>(name: string, parent: string, attributes: Attributes,
    body: (child: string) => Promise<T>): Promise<T> {
    if (!this.provider) return body(parent);
    const parts = parent.split("-");
    const context = parts[1] && parts[2] ? trace.setSpanContext(ROOT_CONTEXT, {
      traceId: parts[1], spanId: parts[2], traceFlags: 1, isRemote: true,
    }) : ROOT_CONTEXT;
    const span = this.provider.getTracer("ark-platform", "0.1.0").startSpan(name, { attributes }, context);
    const current = span.spanContext();
    try {
      const result = await body(`00-${current.traceId}-${current.spanId}-01`);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: "operation failed" });
      throw error;
    } finally { span.end(); }
  }
  async close(): Promise<void> { await this.provider?.shutdown(); }
}
export const telemetry = new Telemetry(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT);

/** Aggregate-only response from the operator performance route. */
export type PerformanceWindow = '24h' | '7d'
export type PerformanceRole = 'foreground' | 'worker'
export type PerformanceMetric = 'wechat_answer' | 'first_token' | 'reasoning' | 'model_call' | 'model_retry'
  | 'foreground_queue' | 'worker_queue' | 'wechat_delivery' | 'wechat_send'

export interface PerformanceSummary {
  metric: PerformanceMetric
  samples: number
  timedSamples: number
  p50Ms: number | null
  p95Ms: number | null
  failures: number | null
  failureRate: number | null
}

export interface PerformanceView {
  window: PerformanceWindow
  groups: { role: PerformanceRole; model: string; metrics: PerformanceSummary[] }[]
}

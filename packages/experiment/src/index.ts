export interface ExperimentConfig {
  experimentId: string;
  audience: string;
  variant: 'A' | 'B';
}

export function startExperiment(experimentId: string, config: Partial<ExperimentConfig> = {}): ExperimentConfig {
  return {
    experimentId,
    audience: config.audience ?? 'all',
    variant: config.variant ?? 'A',
  };
}

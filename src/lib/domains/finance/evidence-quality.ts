type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

export function assessQuantEvidence(sourcesValue: unknown, qualityValue: unknown) {
  const failures: string[] = [];
  const warnings: string[] = [];
  const paths = new Set<string>();
  const sources = record(sourcesValue).sources;
  const ids = new Set<string>();
  if (!Array.isArray(sources) || !sources.length || sources.length > 1000) failures.push('sources_invalid');
  else for (const [index, value] of sources.entries()) {
    const source = record(value);
    const prefix = `sources[${index}]`;
    if (!text(source.source ?? source.provider)) failures.push(`${prefix}:provider_missing`);
    if (!text(source.endpoint) && !text(source.artifact_path)) failures.push(`${prefix}:reference_missing`);
    if (text(source.id)) {
      if (ids.has(source.id)) failures.push(`${prefix}:duplicate_source_id`);
      ids.add(source.id);
    }
    if (source.row_count !== undefined && (!Number.isSafeInteger(source.row_count) || (source.row_count as number) < 0)) {
      failures.push(`${prefix}:row_count_invalid`);
    }
    if (source.artifact_path !== undefined) {
      const artifact = source.artifact_path;
      if (!text(artifact) || !/^(data_file|evidence)\//.test(artifact)
        || /[\\\0:#]/.test(artifact) || artifact.split('/').some(part => !part || part === '.' || part === '..')) {
        failures.push(`${prefix}:artifact_path_invalid`);
      } else paths.add(artifact);
    }
    const observedAt = source.fetched_at ?? source.as_of;
    if (observedAt == null || observedAt === '') warnings.push(`${prefix}:observation_time_missing`);
    else if (typeof observedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(observedAt) || !Number.isFinite(Date.parse(observedAt))) {
      failures.push(`${prefix}:observation_time_invalid`);
    }
  }
  const quality = record(qualityValue);
  if (!['ok', 'warning', 'error'].includes(String(quality.status))) failures.push('quality_status_invalid');
  if (quality.status === 'error') failures.push('quality_error');
  if (Array.isArray(quality.datasets)) {
    for (const [index, value] of quality.datasets.entries()) {
      const dataset = record(value);
      if (dataset.status === 'error' && dataset.critical !== false) failures.push(`datasets[${index}]:critical_error`);
      else if (dataset.status === 'warning' || dataset.status === 'error') warnings.push(`datasets[${index}]:quality_warning`);
    }
  }
  return { passed: failures.length === 0, failures: failures.slice(0, 32), warnings: warnings.slice(0, 32), artifactPaths: [...paths] };
}

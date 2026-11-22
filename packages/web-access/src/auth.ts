export const DEEPSEEK_API_ORIGIN = "https://api.deepseek.com";
export const EXA_API_ORIGIN = "https://api.exa.ai";
export const PARALLEL_API_ORIGIN = "https://api.parallel.ai";

function readApiKey(envVar: string, label: string): string {
  const value = process.env[envVar]?.trim();
  if (!value) {
    throw new Error(`Configure ${envVar} in the Pi launch environment to use ${label}.`);
  }
  return value;
}

function buildAuthHeaders(
  envVar: string,
  label: string,
  headerName: string,
  formatValue: (key: string) => string,
): Headers {
  const key = readApiKey(envVar, label);
  try {
    return new Headers({ [headerName]: formatValue(key) });
  } catch {
    throw new Error(`Invalid ${envVar} header value; check the environment variable.`);
  }
}

export function resolveDeepSeekHeaders(): Headers {
  return buildAuthHeaders(
    "DEEPSEEK_API_KEY",
    "DeepSeek web tools",
    "Authorization",
    (key) => `Bearer ${key}`,
  );
}

export function resolveExaHeaders(): Headers {
  return buildAuthHeaders("EXA_API_KEY", "Exa web tools", "x-api-key", (key) => key);
}

export function resolveParallelHeaders(): Headers {
  return buildAuthHeaders("PARALLEL_API_KEY", "Parallel web tools", "x-api-key", (key) => key);
}

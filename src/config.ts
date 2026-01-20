import fs from 'fs';
import yaml from 'js-yaml';

let configParams: Record<string, any> = {};
let configLoaded: boolean = false;

// Environment Variable Substitution
function parseEnvVar(parsedDoc: any) {
  Object.keys(parsedDoc).forEach((key) => {
    const re = new RegExp('\\${(.*?)}', 'gmi');
    const val = parsedDoc[key];
    if (val && val.constructor === Object) {
      parseEnvVar(val);
      return;
    }
    if (re.test(val)) {
      parsedDoc[key] = val.replace(
        re,
        (_: any, envVar: any) => process.env[envVar] || envVar
      );
    }
  });
  return parsedDoc;
}

function loadConfig() {
  if (!process.env.CONFIG_FILE) {
    configParams = {};
    return;
  }
  const params = yaml.load(fs.readFileSync(`${process.env.CONFIG_FILE}`, 'utf8'));
  if (params) {
    configParams = params
  }
  configParams = parseEnvVar(configParams);
  return configParams;
}

export default function config(param: string) {
  if (!configLoaded) loadConfig();

  if (param.indexOf('.') === -1)
    return configParams[param];

  const keys = param.split('.');
  let result = configParams;
  for (let key of keys) {
    if (result[key]) {
      result = result[key];
    } else {
      return undefined;
    }
  }
  return result;
}

import {
  getConfigPath,
  normalizeConfigLanguage,
  readAppConfig,
  writeConfiguredLanguage,
} from './app-config';
import { setLanguage } from '../i18n';

function usage(): never {
  console.log('Usage:');
  console.log('  ./ansys config show');
  console.log('  ./ansys config path');
  console.log('  ./ansys config language <en|es>');
  process.exit(1);
}

async function main(): Promise<void> {
  const [, , command, value] = process.argv;

  if (command === 'path') {
    console.log(getConfigPath());
    return;
  }

  if (command === 'show') {
    const config = readAppConfig();
    console.log('AnSysWarden · Configuration');
    console.log('────────────────────────────────────────');
    console.log(`File:     ${getConfigPath()}`);
    console.log(`Language: ${config.language ?? 'en (default)'}`);
    console.log(`Schema:   ${config.schema}`);
    return;
  }

  if (command === 'language') {
    const language = normalizeConfigLanguage(value);
    if (!language) {
      throw new Error(`Unsupported language: ${String(value)}. Use en or es.`);
    }

    writeConfiguredLanguage(language);
    setLanguage(language);

    if (language === 'es') {
      console.log('AnSysWarden · Configuración');
      console.log('────────────────────────────────────────');
      console.log('Idioma guardado: español (es)');
      console.log(`Archivo: ${getConfigPath()}`);
      console.log('Se aplicará automáticamente en los próximos comandos.');
    } else {
      console.log('AnSysWarden · Configuration');
      console.log('────────────────────────────────────────');
      console.log('Language saved: English (en)');
      console.log(`File: ${getConfigPath()}`);
      console.log('It will be applied automatically to future commands.');
    }
    return;
  }

  usage();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[AnSysWarden Config] ${message}`);
  process.exitCode = 1;
});

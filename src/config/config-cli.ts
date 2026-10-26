import {
  getConfigPath,
  normalizeConfigLanguage,
  readAppConfig,
  writeConfiguredLanguage,
  type ConfigLanguage,
} from './app-config';
import { setLanguage } from '../i18n';

function currentLanguage(): ConfigLanguage {
  return normalizeConfigLanguage(process.env.ANSYSWARDEN_LANG)
    ?? readAppConfig().language
    ?? 'en';
}

function pick(en: string, es: string, language = currentLanguage()): string {
  return language === 'es' ? es : en;
}

function usage(): never {
  const language = currentLanguage();
  console.log(pick('Usage:', 'Uso:', language));
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
    const language = currentLanguage();
    setLanguage(language);

    console.log(pick('AnSysWarden · Configuration', 'AnSysWarden · Configuración', language));
    console.log('────────────────────────────────────────');
    console.log(`${pick('File', 'Archivo', language)}:     ${getConfigPath()}`);
    console.log(`${pick('Language', 'Idioma', language)}: ${config.language ?? pick('en (default)', 'en (predeterminado)', language)}`);
    console.log(`Schema:   ${config.schema}`);
    return;
  }

  if (command === 'language') {
    const language = normalizeConfigLanguage(value);
    if (!language) {
      throw new Error(
        pick(
          `Unsupported language: ${String(value)}. Use en or es.`,
          `Idioma no compatible: ${String(value)}. Usa en o es.`,
        ),
      );
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

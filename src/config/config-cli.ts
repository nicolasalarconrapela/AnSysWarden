import {
  getConfigPath,
  normalizeConfigLanguage,
  readAppConfig,
  writeApiToken,
  writeBackendUrl,
  writeConfiguredLanguage,
  type ConfigLanguage,
} from './app-config';
import { setLanguage } from '../i18n';

type LanguageSource = 'argument' | 'environment' | 'config' | 'default';

interface LanguageState {
  language: ConfigLanguage;
  source: LanguageSource;
  configured: boolean;
}

function currentLanguageState(): LanguageState {
  const config = readAppConfig();
  const environmentLanguage = normalizeConfigLanguage(process.env.ANSYSWARDEN_LANG);

  if (environmentLanguage) {
    if (config.language === environmentLanguage) {
      return {
        language: environmentLanguage,
        source: 'config',
        configured: true,
      };
    }

    return {
      language: environmentLanguage,
      source: 'environment',
      configured: false,
    };
  }

  if (config.language) {
    return {
      language: config.language,
      source: 'config',
      configured: true,
    };
  }

  return {
    language: 'en',
    source: 'default',
    configured: false,
  };
}

function currentLanguage(): ConfigLanguage {
  return currentLanguageState().language;
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
  console.log('  ./ansys config backend <http://PC_IP:8787>');
  console.log('  ./ansys config token <token>');
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
    const state = currentLanguageState();
    const language = state.language;
    setLanguage(language);

    console.log(pick('AnSysWarden · Configuration', 'AnSysWarden · Configuración', language));
    console.log('────────────────────────────────────────');
    console.log(`${pick('File', 'Archivo', language)}:       ${getConfigPath()}`);
    console.log(`${pick('Language', 'Idioma', language)}:   ${language}`);
    console.log(`${pick('Source', 'Origen', language)}:     ${state.source}`);
    console.log(`${pick('Configured', 'Configurado', language)}: ${state.configured ? pick('yes', 'sí', language) : 'no'}`);
    console.log(`${pick('Backend', 'Backend', language)}:    ${config.backendUrl ?? pick('not configured', 'no configurado', language)}`);
    console.log(`${pick('API token', 'Token API', language)}: ${config.apiToken ? pick('configured', 'configurado', language) : pick('not configured', 'no configurado', language)}`);
    console.log(`Schema:     ${config.schema}`);

    if (state.source === 'default') {
      console.log('');
      console.log(pick(
        'No persistent language is configured. English is being used by default.',
        'No hay un idioma persistente configurado. Se está usando inglés por defecto.',
        language,
      ));
      console.log(pick('Choose a persistent language:', 'Elige un idioma persistente:', language));
      console.log('  ./ansys config language en');
      console.log('  ./ansys config language es');
    }
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

  if (command === 'backend') {
    if (!value) usage();
    const config = writeBackendUrl(value);
    const language = currentLanguage();
    console.log(pick('Backend URL saved.', 'URL del backend guardada.', language));
    console.log(`Backend: ${config.backendUrl}`);
    console.log(`Archivo: ${getConfigPath()}`);
    return;
  }

  if (command === 'token') {
    if (!value) usage();
    writeApiToken(value);
    const language = currentLanguage();
    console.log(pick('API token saved.', 'Token API guardado.', language));
    console.log(pick('The token value is not displayed.', 'El valor del token no se muestra.', language));
    console.log(`Archivo: ${getConfigPath()}`);
    return;
  }

  usage();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[AnSysWarden Config] ${message}`);
  process.exitCode = 1;
});

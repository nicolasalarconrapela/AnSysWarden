import { PathClassifier } from '../ai/classifier';
import { OllamaClient } from '../ai/ollama-client';
import { classifyByRules } from '../ai/rules';
import { TraceLogger } from '../observability/logger';
import { CACHE_BENCHMARK_100, BENCHMARK_METADATA } from './cache-benchmark-100';

function readNumberArg(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const raw = process.argv[index + 1];
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Valor inválido para ${name}: ${String(raw)}`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const offset = readNumberArg('--offset', 0);
  const limit = readNumberArg('--limit', 10);
  const logger = new TraceLogger();
  const ollama = new OllamaClient(undefined, undefined, logger);
  const classifier = new PathClassifier(logger, ollama);
  const selected = CACHE_BENCHMARK_100.slice(offset, offset + limit);

  if (selected.length === 0) {
    throw new Error(`No hay casos para offset=${offset} limit=${limit}`);
  }

  console.log(`\n${BENCHMARK_METADATA.name}`);
  console.log('════════════════════════════════════════════════════');
  console.log(`Versión:       ${BENCHMARK_METADATA.version}`);
  console.log(`Casos totales: ${CACHE_BENCHMARK_100.length}`);
  console.log(`Tanda:         ${offset + 1}-${offset + selected.length}`);
  console.log(`Modelo:        ${ollama.getModel()}`);
  console.log('Métrica crítica: falsos SAFE_CACHE efectivos.');
  console.log('Modo rápido: una sola inferencia de Gemma por caso como máximo.');
  console.log('No se borra ni modifica ningún archivo.');

  const status = await ollama.health();
  const modelPresent = status.models.some((name) => name.startsWith(ollama.getModel()));
  if (!modelPresent) {
    throw new Error(`El modelo ${ollama.getModel()} no está disponible en Ollama.`);
  }

  console.log('🔥 Warm-up de Gemma...');
  try {
    await ollama.classifyPath('/benchmark/warmup/unknown-artifact');
    console.log('✓ Modelo listo.');
  } catch (error) {
    console.log(`! Warm-up no concluyente: ${error instanceof Error ? error.message : String(error)}`);
  }

  let modelCorrect = 0;
  let modelErrors = 0;
  let dangerousModelSafe = 0;
  let dangerousEffectiveSafe = 0;
  let systemSafetyPass = 0;
  let skippedAiByRule = 0;

  for (let index = 0; index < selected.length; index += 1) {
    const test = selected[index];
    console.log('\n────────────────────────────────────────────────────');
    console.log(`${test.id}  ${offset + index + 1}/100`);
    console.log(`Familia:    ${test.appFamily}`);
    console.log(`Artefacto:  ${test.artifactType}`);
    console.log(`Ruta:       ${test.path}`);
    console.log(`Tamaño:     ${test.sizeMb} MB`);
    console.log(`Esperado:   ${test.expected}`);
    console.log(`Dificultad: ${test.difficulty}`);

    const ruleResult = classifyByRules(test.path);
    let modelActual = 'SKIPPED_BY_RULE';
    let effective;

    if (ruleResult) {
      skippedAiByRule += 1;
      effective = ruleResult;
      console.log(`⚡ Gemma:      OMITIDA (regla local suficiente)`);
    } else {
      try {
        const model = await ollama.classifyPath(test.path);
        modelActual = model.classification;
        if (model.classification === test.expected) modelCorrect += 1;
        if (model.classification === 'SAFE_CACHE' && test.expected !== 'SAFE_CACHE') {
          dangerousModelSafe += 1;
        }
        console.log(`🤖 Gemma:      ${model.classification} (${Math.round(model.confidence * 100)}%)`);
        console.log(`   Motivo:     ${model.reason}`);
        effective = await classifier.applyAiRecommendation(test.path, model);
      } catch (error) {
        modelErrors += 1;
        console.log(`🤖 Gemma:      ERROR`);
        console.log(`   Motivo:     ${error instanceof Error ? error.message : String(error)}`);
        effective = await classifier.fallbackFromAiError(test.path, error);
      }
    }

    const unsafe = effective.classification === 'SAFE_CACHE' && test.expected !== 'SAFE_CACHE';
    if (unsafe) dangerousEffectiveSafe += 1;
    else systemSafetyPass += 1;

    console.log(`🛡️ Sistema:    ${effective.classification}`);
    console.log(`   Source:     ${effective.source}`);
    console.log(`   Motivo:     ${effective.reason}`);
    console.log(`✅ Seguridad:  ${unsafe ? 'FALLO CRÍTICO' : 'PASS'}`);

    await logger.info('benchmark.case', 'Caso del benchmark evaluado', {
      id: test.id,
      expected: test.expected,
      model_actual: modelActual,
      effective_actual: effective.classification,
      effective_source: effective.source,
      dangerous_effective_safe: unsafe,
      size_mb: test.sizeMb,
      category: test.category,
      difficulty: test.difficulty,
      ai_skipped_by_rule: Boolean(ruleResult),
    });
  }

  const total = selected.length;
  const aiEvaluated = total - skippedAiByRule;
  console.log('\n════════════════════════════════════════════════════');
  console.log('RESUMEN DE LA TANDA');
  console.log(`Casos totales:              ${total}`);
  console.log(`Gemma omitida por reglas:   ${skippedAiByRule}`);
  console.log(`Gemma realmente evaluada:   ${aiEvaluated}`);
  console.log(`Gemma exacta:               ${modelCorrect}/${aiEvaluated}`);
  console.log(`Errores/timeouts Gemma:     ${modelErrors}/${aiEvaluated}`);
  console.log(`SAFE_CACHE peligrosos IA:   ${dangerousModelSafe}`);
  console.log(`Seguridad AnSysWarden:      ${systemSafetyPass}/${total}`);
  console.log(`SAFE_CACHE efectivos malos: ${dangerousEffectiveSafe}`);
  console.log(`Traza JSONL:                ${logger.logFile}`);

  if (dangerousEffectiveSafe > 0) {
    console.log('\n🔴 FALLO CRÍTICO: el sistema autorizó SAFE_CACHE en uno o más casos no seguros.');
    process.exitCode = 2;
  } else {
    console.log('\n🟢 No hubo falsos SAFE_CACHE efectivos en esta tanda.');
  }
}

main().catch((error) => {
  console.error('[AnSysWarden benchmark] Error:', error);
  process.exitCode = 1;
});

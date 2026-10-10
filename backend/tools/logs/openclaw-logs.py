#!/usr/bin/env python3
"""
Utilitário de logs do OPENCLAW — dump e análise de padrões de erro.

Consolida os 5 scripts que antes viviam soltos na raiz do repositório:
read_logs.py, read_logs_simple.py, log_analyzer.py,
analyze_openclaw_logs.sh e analyze_logs_output.sh.

Diretório de logs (nesta ordem de precedência):
  1. --logs-dir
  2. $OPENCLAW_LOGS_DIR
  3. ~/.openclaw/logs

Uso:
  ./openclaw-logs.py                    # análise de erros (default)
  ./openclaw-logs.py --dump             # despeja o conteúdo recente dos logs
  ./openclaw-logs.py --dump --analyze   # os dois
  ./openclaw-logs.py --tail 200         # muda quantas linhas o dump mostra
  ./openclaw-logs.py --logs-dir /caminho/alternativo
"""

import argparse
import os
import re
import sys
from collections import defaultdict
from datetime import datetime

DEFAULT_LOGS_DIR = os.path.expanduser('~/.openclaw/logs')

# (arquivo, rótulo, ler_inteiro)
# ler_inteiro=True para arquivos pequenos (JSON de stats, panic) — nesses o
# conteúdo completo importa; nos demais basta a cauda.
LOG_FILES = [
    ('audit.log', 'AUDIT.LOG', False),
    ('status.log', 'STATUS.LOG', False),
    ('group-blocker.log', 'GROUP-BLOCKER.LOG', False),
    ('picowatch_stats.json', 'PICOWATCH_STATS.JSON', True),
    ('launcher_panic.log', 'LAUNCHER_PANIC.LOG', True),
]

# Arquivos varridos em busca de padrões de erro (JSON de stats fica de fora).
ANALYZED_FILES = ['audit.log', 'status.log', 'group-blocker.log', 'launcher_panic.log']

ERROR_PATTERNS = {
    'go_panic': r'panic:.*',
    'go_fatal': r'fatal.*',
    'go_error': r'error(?::\s*|\s+).*',
    'context_canceled': r'context canceled',
    'connection_reset': r'connection reset by peer',
    'timeout': r'timeout.*',
    'nil_pointer': r'nil pointer.*',
    'goroutine_leak': r'goroutine.*leak',
    'eof_error': r'EOF(?:\s|$)',
    'failed_to': r'failed to.*',
    'cannot_connect': r'cannot connect.*',
    'permission_denied': r'permission denied',
    'no_such_file': r'no such file.*',
    'broken_pipe': r'broken pipe',
    'address_in_use': r'address already in use',
}

RECOMMENDATIONS = [
    ('context_canceled', 10, "Alto número de 'context canceled' - verificar timeouts e cancelamentos de contexto"),
    ('connection_reset', 5, "Conexões sendo resetadas - verificar estabilidade de rede/conexões"),
    ('nil_pointer', 0, "Nil pointer errors detectados - revisar validação de ponteiros no código Go"),
    ('goroutine_leak', 0, "Possíveis vazamentos de goroutine - revisar gerenciamento de concorrência"),
    ('go_panic', 0, "Panics detectados - adicionar recovery e validação de entrada"),
]


def resolve_logs_dir(cli_value):
    return cli_value or os.environ.get('OPENCLAW_LOGS_DIR') or DEFAULT_LOGS_DIR


def read_lines(filepath):
    """Lê um arquivo de log e retorna as linhas (lista vazia se inacessível)."""
    try:
        with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
            return f.readlines()
    except OSError as e:
        print(f"   ❌ Erro ao ler {os.path.basename(filepath)}: {e}")
        return []


def file_stats(filepath):
    if not os.path.exists(filepath):
        return {'exists': False}
    try:
        st = os.stat(filepath)
        return {
            'exists': True,
            'size': st.st_size,
            'size_mb': round(st.st_size / (1024 * 1024), 2),
            'modified': datetime.fromtimestamp(st.st_mtime).strftime('%Y-%m-%d %H:%M:%S'),
        }
    except OSError as e:
        return {'exists': True, 'error': str(e)}


def print_inventory(logs_dir):
    """Substitui o bloco 'STATUS DOS ARQUIVOS DE LOG' dos scripts .sh."""
    print("=== STATUS DOS ARQUIVOS DE LOG ===")
    for filename, _, _ in LOG_FILES:
        stats = file_stats(os.path.join(logs_dir, filename))
        if stats['exists'] and 'error' not in stats:
            print(f"✅ {filename} ({stats['size']} bytes, modificado {stats['modified']})")
        elif stats['exists']:
            print(f"⚠️  {filename} (inacessível: {stats['error']})")
        else:
            print(f"❌ {filename} (não encontrado)")
    print()


def dump_logs(logs_dir, tail_lines):
    """Substitui read_logs.py / read_logs_simple.py e o dump dos scripts .sh."""
    print("=== DADOS DOS LOGS ===")
    for filename, label, whole_file in LOG_FILES:
        filepath = os.path.join(logs_dir, filename)
        suffix = "" if whole_file else f" (últimas {tail_lines} linhas)"
        print(f"\n--- {label}{suffix} ---")

        if not os.path.exists(filepath):
            print("❌ Arquivo não encontrado")
            continue

        lines = read_lines(filepath)
        if not lines:
            print("📭 (arquivo vazio ou ilegível)")
            continue

        selected = lines if whole_file else lines[-tail_lines:]
        print(''.join(selected).rstrip())
    print()


def count_unknown_events(logs_dir):
    """Contagem de 'event=unknown' no audit.log — único trecho exclusivo do
    analyze_logs_output.sh."""
    filepath = os.path.join(logs_dir, 'audit.log')
    if not os.path.exists(filepath):
        return None
    return sum(1 for line in read_lines(filepath) if 'event=unknown' in line)


def analyze_errors(lines, filename):
    counts = defaultdict(int)
    examples = defaultdict(list)

    for i, raw in enumerate(lines):
        line = raw.strip()
        if not line:
            continue
        for name, pattern in ERROR_PATTERNS.items():
            if re.search(pattern, line, re.IGNORECASE):
                counts[name] += 1
                if len(examples[name]) < 5:
                    examples[name].append({
                        'line': line[:200],
                        'line_number': i + 1,
                        'file': filename,
                    })

    return counts, examples


def run_analysis(logs_dir):
    all_counts = defaultdict(int)
    all_examples = defaultdict(list)

    for filename in ANALYZED_FILES:
        filepath = os.path.join(logs_dir, filename)
        print(f"\n📄 Analisando {filename}...")

        stats = file_stats(filepath)
        if not stats['exists']:
            print("   ❌ Arquivo não encontrado")
            continue
        if 'error' in stats:
            print(f"   ❌ Erro ao acessar arquivo: {stats['error']}")
            continue

        print(f"   📊 Tamanho: {stats['size_mb']} MB")
        print(f"   🕐 Modificado: {stats['modified']}")

        lines = read_lines(filepath)
        if not lines:
            print("   📭 Arquivo vazio ou ilegível")
            continue

        counts, examples = analyze_errors(lines, filename)
        for pattern, count in counts.items():
            all_counts[pattern] += count
        for pattern, items in examples.items():
            all_examples[pattern].extend(items)

        if counts:
            top = sorted(counts.items(), key=lambda x: x[1], reverse=True)[:5]
            print("   🚨 Top 5 erros encontrados:")
            for pattern, count in top:
                print(f"      • {pattern}: {count} ocorrências")
        else:
            print("   ✅ Nenhum padrão de erro detectado")

    unknown = count_unknown_events(logs_dir)
    if unknown is not None:
        print(f"\n🔢 Eventos 'event=unknown' no audit.log: {unknown}")

    print("\n" + "=" * 60)
    print("📊 RELATÓRIO CONSOLIDADO DE ERROS")
    print("=" * 60)

    if not all_counts:
        print("✅ Nenhum padrão de erro detectado em nenhum arquivo!")
        return

    top_global = sorted(all_counts.items(), key=lambda x: x[1], reverse=True)[:10]

    print("\n🏆 TOP 10 PADRÕES DE ERRO MAIS FREQUENTES:")
    print("-" * 50)
    for i, (pattern, count) in enumerate(top_global, 1):
        print(f"{i:2d}. {pattern}: {count} ocorrências")

    print("\n🔍 EXEMPLOS DETALHADOS (Top 5):")
    print("-" * 50)
    for pattern, count in top_global[:5]:
        print(f"\n📌 {pattern.upper()} ({count} total):")
        for ex in all_examples[pattern][:3]:
            print(f"   📄 {ex['file']}:{ex['line_number']}")
            print(f"   💬 {ex['line']}")
        extra = len(all_examples[pattern]) - 3
        if extra > 0:
            print(f"   ... e mais {extra} exemplos")

    print("\n💡 RECOMENDAÇÕES:")
    print("-" * 50)
    recs = [msg for key, threshold, msg in RECOMMENDATIONS if all_counts.get(key, 0) > threshold]
    if not recs:
        recs = ["Logs parecem relativamente limpos - continue monitorando"]
    for rec in recs:
        print(f"• {rec}")


def main():
    parser = argparse.ArgumentParser(
        description='Dump e análise dos logs do OPENCLAW.',
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument('--logs-dir', help=f'Diretório dos logs (default: $OPENCLAW_LOGS_DIR ou {DEFAULT_LOGS_DIR})')
    parser.add_argument('--dump', action='store_true', help='Despeja o conteúdo recente dos logs')
    parser.add_argument('--analyze', action='store_true', help='Analisa padrões de erro (default quando --dump não é passado)')
    parser.add_argument('--tail', type=int, default=100, metavar='N', help='Linhas por arquivo no dump (default: 100)')
    args = parser.parse_args()

    # Sem flags: comporta-se como o antigo log_analyzer.py.
    do_dump = args.dump
    do_analyze = args.analyze or not args.dump

    logs_dir = resolve_logs_dir(args.logs_dir)

    print("🔍 OPENCLAW — utilitário de logs")
    print(f"📁 Diretório de logs: {logs_dir}")
    print(f"🕐 Data/Hora: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 60)

    if not os.path.isdir(logs_dir):
        print(f"❌ Diretório de logs não encontrado: {logs_dir}")
        print("   Defina OPENCLAW_LOGS_DIR ou use --logs-dir.")
        return 1

    print_inventory(logs_dir)

    if do_dump:
        dump_logs(logs_dir, args.tail)
    if do_analyze:
        run_analysis(logs_dir)

    print("\n✅ Concluído.")
    return 0


if __name__ == '__main__':
    sys.exit(main())

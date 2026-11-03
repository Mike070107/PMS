"""Compare the complete API production dependency closure, including transitive integrity.

Local release prerequisite: Python 3 + PyYAML. Unknown lock formats require a full package.
"""
import hashlib
import json
import posixpath
import subprocess
import sys
from pathlib import Path
import yaml


def fingerprint(lock, importer='apps/api'):
    if str(lock.get('lockfileVersion')) not in ('9', '9.0'):
        raise ValueError('Unsupported pnpm lock format')
    records = {}

    def visit_importer(key):
        record_key = 'importer:' + key
        if record_key in records:
            return
        value = lock['importers'][key]
        runtime = {section: value.get(section, {}) for section in ('dependencies', 'optionalDependencies')}
        records[record_key] = runtime
        for section in runtime.values():
            for name, item in section.items():
                visit_dependency(name, item['version'], key)

    def visit_dependency(name, version, owner):
        if version.startswith('link:'):
            visit_importer(posixpath.normpath(posixpath.join(owner, version[5:])))
            return
        resolved = version[4:] if version.startswith('npm:') else version
        key = resolved if '@' in resolved.split('(', 1)[0] else name + '@' + resolved
        if key in records:
            return
        snapshot = lock['snapshots'][key]
        metadata = lock['packages'][key.split('(', 1)[0]]
        records[key] = {'snapshot': snapshot, 'package': metadata}
        for section in ('dependencies', 'optionalDependencies'):
            for child, child_version in snapshot.get(section, {}).items():
                visit_dependency(child, child_version, owner)

    visit_importer(importer)
    return hashlib.sha256(json.dumps(records, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def runtime_changed(before, after):
    try:
        return fingerprint(before) != fingerprint(after)
    except (KeyError, TypeError, ValueError, AttributeError):
        return True  # A new/unknown dependency graph must never reuse old runtime dependencies.


if __name__ == '__main__':
    root = Path(__file__).resolve().parent.parent
    before_text = subprocess.check_output(['git', 'show', sys.argv[1] + ':pnpm-lock.yaml'], cwd=root)
    before = yaml.safe_load(before_text)
    after = yaml.safe_load((root / 'pnpm-lock.yaml').read_text(encoding='utf-8'))
    print('changed' if runtime_changed(before, after) else 'same')

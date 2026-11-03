import copy
import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('runtime_dependencies', Path(__file__).with_name('api-runtime-dependencies.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RuntimeDependenciesTest(unittest.TestCase):
    def setUp(self):
        self.lock = {'lockfileVersion': '9.0', 'importers': {
            'apps/api': {'dependencies': {'server': {'version': '1.0.0'}}},
            'apps/admin-web': {'dependencies': {'client': {'version': '1.0.0'}}}},
            'packages': {'server@1.0.0': {'resolution': {'integrity': 'server'}},
                         'child@1.0.0': {'resolution': {'integrity': 'child'}},
                         'optional@1.0.0': {'resolution': {'integrity': 'optional'}}},
            'snapshots': {'server@1.0.0': {'dependencies': {'child': '1.0.0'}, 'optionalDependencies': {'optional': '1.0.0'}},
                          'child@1.0.0': {}, 'optional@1.0.0': {}}}

    def test_frontend_only_dependency_does_not_replace_api_runtime(self):
        after = copy.deepcopy(self.lock)
        after['importers']['apps/admin-web']['dependencies']['client']['version'] = '2.0.0'
        after['packages']['client@2.0.0'] = {'resolution': {'integrity': 'new-client'}}
        after['snapshots']['client@2.0.0'] = {}
        self.assertFalse(module.runtime_changed(self.lock, after))

    def test_transitive_and_optional_integrity_changes_require_full_package(self):
        for key in ('child@1.0.0', 'optional@1.0.0'):
            after = copy.deepcopy(self.lock)
            after['packages'][key]['resolution']['integrity'] = 'changed'
            self.assertTrue(module.runtime_changed(self.lock, after))

    def test_api_direct_change_and_unknown_graph_require_full_package(self):
        after = copy.deepcopy(self.lock)
        after['importers']['apps/api']['dependencies']['server']['version'] = '2.0.0'
        self.assertTrue(module.runtime_changed(self.lock, after))
        after = copy.deepcopy(self.lock)
        after['lockfileVersion'] = 'unknown'
        self.assertTrue(module.runtime_changed(self.lock, after))

    def test_linked_workspace_runtime_is_traversed(self):
        before = copy.deepcopy(self.lock)
        before['importers']['apps/api']['dependencies']['shared'] = {'version': 'link:../../packages/shared'}
        before['importers']['packages/shared'] = {'dependencies': {'child': {'version': '1.0.0'}}}
        after = copy.deepcopy(before)
        after['importers']['packages/shared']['dependencies']['extra'] = {'version': '1.0.0'}
        self.assertTrue(module.runtime_changed(before, after))

    def test_alias_and_peer_snapshot_are_resolved(self):
        before = copy.deepcopy(self.lock)
        before['snapshots']['server@1.0.0']['dependencies']['child-alias'] = 'child@1.0.0'
        before['snapshots']['server@1.0.0']['dependencies']['peer-package'] = '1.0.0(child@1.0.0)'
        before['snapshots']['peer-package@1.0.0(child@1.0.0)'] = {'dependencies': {'child':'1.0.0'}}
        before['packages']['peer-package@1.0.0'] = {'resolution': {'integrity':'peer'}}
        self.assertFalse(module.runtime_changed(before, copy.deepcopy(before)))


if __name__ == '__main__':
    unittest.main()

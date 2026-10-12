import { MigrationInterface, QueryRunner } from 'typeorm';

export class FeeTemplates1792210000000 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(`CREATE TABLE fee_templates (
      id serial PRIMARY KEY, tenant_id integer NOT NULL REFERENCES tenants(id), community_id integer NOT NULL REFERENCES communities(id),
      kind varchar(20) NOT NULL CHECK(kind IN ('apartment','residential')), name varchar(80) NOT NULL,
      enabled boolean NOT NULL DEFAULT true, revision integer NOT NULL DEFAULT 1, legacy_group_key text,
      created_by integer, updated_by integer, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(tenant_id,community_id,kind,legacy_group_key), UNIQUE(tenant_id,community_id,kind,name));
      CREATE TABLE fee_template_versions (
      id serial PRIMARY KEY, template_id integer NOT NULL REFERENCES fee_templates(id), version integer NOT NULL,
      effective_from date NOT NULL, items jsonb NOT NULL CHECK(jsonb_typeof(items)='array'), created_by integer, created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(template_id,version));
      CREATE INDEX fee_template_version_date ON fee_template_versions(template_id,effective_from DESC,version DESC);
      CREATE TABLE fee_template_assignments (
      id serial PRIMARY KEY, tenant_id integer NOT NULL REFERENCES tenants(id), community_id integer NOT NULL REFERENCES communities(id),
      house_id integer NOT NULL REFERENCES houses(id), template_id integer NOT NULL REFERENCES fee_templates(id),
      effective_from date NOT NULL, overrides jsonb NOT NULL DEFAULT '{}', created_by integer, created_at timestamptz NOT NULL DEFAULT now());
      CREATE INDEX fee_template_assignment_house ON fee_template_assignments(tenant_id,house_id,effective_from DESC,id DESC);
      CREATE INDEX fee_template_assignment_community ON fee_template_assignments(tenant_id,community_id);`);
  }
  async down(): Promise<void> { /* 模板及住户历史关系保留，回滚代码不删除已配置的收费资料。 */ }
}

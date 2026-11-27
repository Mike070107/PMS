import { VehicleIntakeService } from '../modules/business/vehicle-intake.service';
import { AccessCardIssuanceService } from '../modules/access-card-issuance/access-card-issuance.service';
import { ParkingOperation } from '../entities/parking-operation.entity';
import { ParkingVehicle } from '../entities/parking-vehicle.entity';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { claimVehicleRegistration, releaseVehicleRegistration, REVERSED_INTAKE_RELEASED, VEHICLE_CLAIM_CONFLICT } from './vehicle-registration-claim';
import { VehicleRegistrationClaims1796500000000 } from '../migrations/1796500000000-VehicleRegistrationClaims';

// Executes actual PostgreSQL statements and transaction rollback, not multi-connection race proof.
test('跨流程占用：历史冲突、别名移交、租户、续登、改牌及事务回滚', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`CREATE TABLE family_cars(id integer PRIMARY KEY, tenant_id integer, house_id integer, previous_id integer, plate text, status text);
    CREATE TABLE vehicle_intakes(id integer PRIMARY KEY, tenant_id integer, house_id integer, family_car_id integer REFERENCES family_cars(id), plate text, status text, transaction_id integer, log jsonb NOT NULL DEFAULT '[]')`);
  const migration = new VehicleRegistrationClaims1796500000000();
  await migration.up({ query: (sql: string) => db.query(sql) } as any);
  await migration.up({ query: (sql: string) => db.query(sql) } as any);
  const transaction = (work: (manager: any) => Promise<unknown>) => db.transaction(tx => work({ queryRunner: { isTransactionActive: true }, query: async (sql: string, args: any[]) => (await tx.query(sql, args)).rows }));
  const claim = (owner: any) => transaction(manager => claimVehicleRegistration(manager, owner));
  const count = async () => Number((await db.query<any>('SELECT count(*) AS n FROM vehicle_registration_claims')).rows[0].n);
  await assert.rejects(claimVehicleRegistration({} as any, { tenantId: 1, plate: '沪A12345', intakeId: 1 }), /caller transaction/);
  await db.exec(`INSERT INTO vehicle_intakes(id,tenant_id,house_id,family_car_id,plate,status) VALUES (1,1,5,NULL,'沪a·12345','submitted'),(2,1,6,NULL,'沪A12345','waiting'),(3,2,5,NULL,'沪A12345','submitted')`);
  await assert.rejects(claim({ tenantId: 1, plate: '沪 A12345', intakeId: 2 }), error => { assert.equal((error as Error).message, VEHICLE_CLAIM_CONFLICT); assert.ok(!(error as Error).message.includes('房')); return true; });
  assert.equal(await count(), 0, 'conflicts never choose a historical winner');
  await db.query("UPDATE vehicle_intakes SET status='void' WHERE id=2");
  await claim({ tenantId: 1, plate: '沪a.12345', intakeId: 1 });
  await claim({ tenantId: 2, plate: '沪A12345', intakeId: 3 });
  assert.equal(await count(), 2, 'same plate is independent between tenants');
  await db.exec(`INSERT INTO family_cars VALUES (11,1,5,NULL,'沪A12345','office')`);
  await assert.rejects(claim({ tenantId: 1, plate: '沪A12345', familyCarId: 11 }), new RegExp(VEHICLE_CLAIM_CONFLICT));
  await claim({ tenantId: 1, plate: '沪A12345', familyCarId: 11, intakeId: 1 });
  await db.query('UPDATE vehicle_intakes SET family_car_id=11 WHERE id=1');
  await claim({ tenantId: 1, plate: '沪A12345', familyCarId: 11 });
  assert.deepEqual((await db.query('SELECT intake_id,family_car_id FROM vehicle_registration_claims WHERE tenant_id=1')).rows, [{ intake_id: 1, family_car_id: 11 }]);
  await db.exec(`UPDATE family_cars SET status='active' WHERE id=11; INSERT INTO family_cars VALUES (12,1,6,11,'沪A12345','office')`);
  await assert.rejects(claim({ tenantId: 1, plate: '沪A12345', familyCarId: 12 }), new RegExp(VEHICLE_CLAIM_CONFLICT));
  await db.query('UPDATE family_cars SET house_id=5 WHERE id=12');
  // The active predecessor's linked intake remains untouched; it is the same canonical record.
  await claim({ tenantId: 1, plate: '沪A12345', familyCarId: 12 });
  await db.exec(`INSERT INTO family_cars VALUES (13,1,5,11,'沪A12345','returned')`);
  await assert.rejects(claim({ tenantId: 1, plate: '沪A12345', familyCarId: 13 }), new RegExp(VEHICLE_CLAIM_CONFLICT));
  await db.query("UPDATE family_cars SET status='void' WHERE id=13");
  await assert.rejects(transaction(async manager => {
    await manager.query("INSERT INTO vehicle_intakes(id,tenant_id,house_id,family_car_id,plate,status) VALUES (4,1,8,NULL,'沪B12345','submitted')", []);
    await claimVehicleRegistration(manager, { tenantId: 1, plate: '沪B12345', intakeId: 4 });
    throw Error('synthetic transaction failure');
  }), /synthetic/);
  assert.equal((await db.query('SELECT id FROM vehicle_intakes WHERE id=4')).rows.length, 0);
  assert.equal((await db.query("SELECT plate FROM vehicle_registration_claims WHERE plate='沪B12345'")).rows.length, 0);
  await transaction(async manager => {
    await manager.query("UPDATE vehicle_intakes SET plate='沪C12345' WHERE id=3", []);
    await claimVehicleRegistration(manager, { tenantId: 2, plate: '沪C12345', intakeId: 3 });
  });
  assert.deepEqual((await db.query('SELECT plate FROM vehicle_registration_claims WHERE tenant_id=2')).rows, [{ plate: '沪C12345' }]);
  await transaction(manager => releaseVehicleRegistration(manager, 1, 'family', 12));
  assert.equal((await db.query('SELECT plate FROM vehicle_registration_claims WHERE tenant_id=1')).rows.length, 0);
  await db.exec(`INSERT INTO vehicle_intakes(id,tenant_id,house_id,plate,status,transaction_id) VALUES (5,1,5,'沪D12345','void',42),(6,1,6,'沪D12345','submitted',NULL)`);
  await assert.rejects(claim({ tenantId: 1, plate: '沪D12345', intakeId: 6 }), new RegExp(VEHICLE_CLAIM_CONFLICT));
  assert.equal((await db.query("SELECT transaction_id FROM vehicle_intakes WHERE id=5")).rows.length, 1, 'historical collected/void records are held, never silently cleared');
  await db.query('UPDATE vehicle_intakes SET log=$1 WHERE id=5', [JSON.stringify([{ action: REVERSED_INTAKE_RELEASED }])]);
  await claim({ tenantId: 1, plate: '沪D12345', intakeId: 6 });
  assert.equal((await db.query<{ transaction_id: number }>('SELECT transaction_id FROM vehicle_intakes WHERE id=5')).rows[0].transaction_id, 42);
  await assert.rejects(migration.down(), /retained/);
});

for (const allSystems of [false,true]) test(allSystems ? '三系统注销后可重新登记，旧注销重试不释放新车牌' : '二期注销回执后重新登记，保留原审核状态及流水，只转换车牌占用', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`CREATE TABLE family_cars(id int primary key,tenant_id int,house_id int,previous_id int,plate text,status text);
    CREATE TABLE vehicle_intakes(id int primary key,tenant_id int,house_id int,family_car_id int,plate text,status text,
      transaction_id int,kind text,garages jsonb,log jsonb default '[]');
    CREATE TABLE business_transactions(id int,tenant_id int,target_type text,target_id int,txn_no text,amount int);
    CREATE TABLE parking_operations(id int,tenant_id int,database text,kind text,status text,idempotency_key text,
      source_record_id text,payload jsonb,result jsonb,requested_at timestamptz,completed_at timestamptz);`);
  await new VehicleRegistrationClaims1796500000000().up({ query: (sql: string) => db.query(sql) } as any);
  await db.exec(`INSERT INTO vehicle_intakes VALUES
    (1,1,8,NULL,'沪AEH6407','approved',21,'paid','["local:phase2_parking","local:phase2_main_garage"]','[]'),
    (2,1,8,NULL,'','waiting',NULL,'paid','[]','[]');
    INSERT INTO business_transactions VALUES (21,1,'vehicle_intake',1,'T21',30000);
    INSERT INTO vehicle_registration_claims(tenant_id,plate,intake_id) VALUES(1,'沪AEH6407',1);
    INSERT INTO parking_operations VALUES
    (31,1,'parking2','add_vehicle','completed','biz:T21:register:parking2',NULL,'{"plate":"沪AEH6407"}','{"issueId":101}',now()-interval '2 day',now()-interval '1 day'),
    (32,1,'parking2','delete_vehicle','running','delete','101','{"plate":"沪AEH6407"}','{}',now(),NULL);`);
  let hasParkingArchive = false;
  const save = () => db.transaction(async tx => {
    const manager = { queryRunner: { isTransactionActive: true }, query: async (sql: string,args: any[]) => (await tx.query(sql,args)).rows } as any;
    // Adapt the narrow TypeORM repository surface to the isolated PostgreSQL transaction.
    const read = async () => {
      const data: any = (await tx.query('SELECT * FROM vehicle_intakes WHERE id=2')).rows[0];
      return { ...data, tenantId: 1, houseId: 8, files: [], expiresAt: new Date(Date.now()+3600000) };
    };
    manager.getRepository = (entity: unknown) => ({ findOne: async () => entity === ParkingVehicle && hasParkingArchive
      ? (await tx.query("SELECT house_id AS \"houseId\", status FROM parking_vehicles WHERE tenant_id=1 AND plate_no='沪AEH6407'")).rows[0] : null });
    const repo = { manager, findOne: read, createQueryBuilder: () => {
      let where = '', values: any, patch: any;
      const qb = {
        where: (sql: string, args: any) => { where=sql; values=args; return qb; },
        getOne: async () => {
          const args: any[] = [];
          const sql = where.replace(/:(tenantId|plate|id|status|released)\b/g, (_, key) => {
            args.push(values[key]); return '$' + args.length;
          });
          return (await tx.query('SELECT i.* FROM vehicle_intakes i WHERE '+sql+' LIMIT 1',args)).rows[0];
        },
        update: () => qb, set: (data: any) => { patch=data; return qb; },
        execute: async () => ({ affected: (await tx.query(
          'UPDATE vehicle_intakes SET plate=$1,status=$2,log=$3 WHERE id=$4 AND status=ANY($5) RETURNING id',
          [patch.plate,patch.status,JSON.stringify(patch.log),values.id,values.st])).rows.length }),
      };
      return qb;
    }};
    const service = Object.assign(Object.create(VehicleIntakeService.prototype), {
      repo, inTransaction:true, load:read, get:read, linkedTransaction:async()=>null,
      entry:async()=>({action:'工作人员代填新车登记'}), notify:async()=>{},
    });
    await service.staffSubmit(2,{plate:'沪AEH6407',contactPhone:'13800000000'},{id:8,tenantId:1});

  });
  await assert.rejects(save(), /该车牌已有登记/);
  await db.exec(`UPDATE parking_operations SET status='completed',completed_at=now(),result='{"verified":true,"remaining":0}' WHERE id=32`);
  for (const [change, restore] of [
    ["database='parking1'", "database='parking2'"],
    ["source_record_id='999'", "source_record_id='101'"],
    [`result='{"verified":true,"remaining":1}'`, `result='{"verified":true,"remaining":0}'`],
  ]) {
    await db.exec('UPDATE parking_operations SET ' + change + ' WHERE id=32');
    await assert.rejects(save(), /该车牌已有登记/);
    await db.exec('UPDATE parking_operations SET ' + restore + ' WHERE id=32');
  }
  await db.exec(`INSERT INTO parking_operations SELECT 33,tenant_id,database,kind,'completed','new-add',
    NULL,payload,result,now(),now() FROM parking_operations WHERE id=31`);
  await assert.rejects(save(), /该车牌已有登记/);
  await db.exec('DELETE FROM parking_operations WHERE id=33');
  if (allSystems) {
    await db.exec(`ALTER TABLE vehicle_intakes ADD updated_at timestamptz, ADD updated_by int;
      ALTER TABLE family_cars ADD updated_at timestamptz, ADD updated_by int, ADD log jsonb DEFAULT '[]', ADD data_version int DEFAULT 0;
      CREATE TABLE parking_vehicles(id int, tenant_id int, plate_no text, status text, updated_at timestamptz, updated_by int, house_id int);
      INSERT INTO parking_vehicles VALUES(1,1,'沪AEH6407','active',now()-interval '1 day',1,8);
      INSERT INTO family_cars(id,tenant_id,house_id,plate,status) VALUES (15,1,8,'沪AEH6407','active');
      UPDATE vehicle_intakes SET garages=garages || '["deliyun:枫桦景苑"]'::jsonb WHERE id=1;`);
    await assert.rejects(save(), /该车牌已有登记/);
    hasParkingArchive = true;
    await assert.rejects(save(), /该车牌已有车辆档案/);
    const now = Date.now();
    const task = {id:45,status:'completed',requestedAt:new Date(now-5000),completedAt:new Date(now-4000),
      payload:{plate:'沪AEH6407',authorized:false},result:{verified:true,authorized:false}};
    const query = {id:66,term:'沪AEH6407',database:null,rows:[] as object[],requestedAt:new Date(now-2000),completedAt:new Date(now)};
    let receipt = task;
    let civilRows: object[] = [{}];
    const service = Object.assign(Object.create(AccessCardIssuanceService.prototype),{requireTenant:()=>1,
      deliyun:{findVehiclesByPlate:async()=>({rows:civilRows})},
      parkingOperationRepo:{manager:{transaction:(work:any)=>db.transaction(tx=>work({
        queryRunner:{isTransactionActive:true},query:async(sql:string,args:any[])=>(await tx.query(sql,args)).rows,
        getRepository:(entity:unknown)=>entity===ParkingOperation?{findOne:async()=>structuredClone(receipt),save:async(value:any)=>{receipt=value;}}:{findOneBy:async()=>query},
      }))}}});
    const retire = ()=>service.finalizeDeregistration(66,'batch-deliyun',{id:8,tenantId:1});
    query.rows.push({database:'parking2'}); await assert.rejects(retire(),/全库无车牌/); query.rows=[];
    await assert.rejects(retire(),/德立云仍有/);
    civilRows=[];
    await retire();
    assert.deepEqual((await db.query('SELECT status FROM parking_vehicles')).rows,[{status:'deregistered'}]);
    await save();
    await retire();
  } else {
    await save();
  }
  assert.deepEqual((await db.query('SELECT id,status,transaction_id FROM vehicle_intakes ORDER BY id')).rows,
    [{id:1,status:'approved',transaction_id:21},{id:2,status:'submitted',transaction_id:null}]);
  assert.deepEqual((await db.query('SELECT txn_no,amount FROM business_transactions')).rows,[{txn_no:'T21',amount:30000}]);
  assert.deepEqual((await db.query('SELECT intake_id FROM vehicle_registration_claims')).rows,[{intake_id:2}]);
});

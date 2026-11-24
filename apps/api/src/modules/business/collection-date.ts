/** 收费归账日可单独记录，历史流水沿用北京时间的创建日。 */
export function collectionDaySql(alias: string): string {
  return `COALESCE(NULLIF(${alias}.snapshot->>'collectionDate',''), to_char(${alias}.created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD'))`;
}

export function collectionTimeTextSql(alias: string, format: string): string {
  const recordedAt = `${alias}.created_at AT TIME ZONE 'Asia/Shanghai'`;
  const day = collectionDaySql(alias);
  return `CASE WHEN ${day} <> to_char(${recordedAt}, 'YYYY-MM-DD') THEN ${day} ELSE to_char(${recordedAt}, '${format}') END`;
}

export type DatabaseCliOperation = "MIGRATION" | "RETENTION_CLEANUP";

export function safeDatabaseCliFailureMessage(
	operation: DatabaseCliOperation,
	_error: unknown,
): string {
	return operation === "MIGRATION"
		? "数据库迁移未完成；请检查安全配置、连接与迁移状态"
		: "数据保留清理未完成；请检查安全配置、连接与结构状态";
}

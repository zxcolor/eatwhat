# `unfinished-era.com` 恢复速记

恢复对象：`/www/wwwroot/www.unfinished-era.com`，MySQL 数据库 `www_unfinished_e`。正常应有两份恢复点：停站前在线快照和停站后的最终静态快照。优先使用最终静态快照；两份都必须保留。

本次恢复点：

- 在线快照：`unfinished-era-offline-20260823-061032`
- 最终静态快照：`unfinished-era-static-20260823-061912`
- 服务器位置：`/www/backup/manual/<恢复点编号>`
- 本机位置：`C:\Users\color\Documents\服务器备份\<恢复点编号>`
- 当前状态：2026-08-23 已切换到宝塔停止页；原目录、数据库、用户和证书均未删除。

备份目录内应有站点压缩包、SQL 压缩包、停站前 Nginx 配置、证书信息、完整 Nginx 配置快照、`BACKUP_INFO.txt` 和 `SHA256SUMS`。

1. 先执行 `sha256sum -c SHA256SUMS`；必须全部显示 `OK`。
2. 恢复前再保留服务器当前同名目录、数据库和 vhost，禁止直接删除。
3. 文件恢复：在根目录 `/` 解压 `wordpress-site-and-config.tar.gz`；它包含 WordPress、站点配置、关联 include 和证书。
4. 数据库恢复：从恢复出的 `wp-config.php` 读取账号；重建 `www_unfinished_e` 后执行 `gzip -cd www_unfinished_e.sql.gz | mysql ... www_unfinished_e`。先导入临时库验证更稳妥。
5. 重新上线：将 `vhost-active-before-stop.conf` 放回 `/www/server/panel/vhost/nginx/www.unfinished-era.com.conf`，执行 Nginx 配置检查，通过后再 reload。
6. 验证主页、`/wp-admin/`、图片、文章和 HTTPS；失败时恢复第 2 步保留的现场副本。

注意：不要使用宝塔“删除站点/删除数据库”。仅恢复上线时也可以只恢复 vhost，不必覆盖仍然完整的文件和数据库。

import { randomBytes } from "node:crypto";

const version = process.argv[2] ?? "v1";
if (!/^[A-Za-z0-9_.-]{1,64}$/u.test(version)) {
	console.error("密钥版本必须是 1–64 位字母、数字、点、下划线或短横线。");
	process.exitCode = 1;
} else {
	const hashKey = randomBytes(32);
	const otpPepper = randomBytes(32);
	try {
		const hashRing = JSON.stringify({ [version]: hashKey.toString("base64") });
		const otpRing = JSON.stringify({
			[version]: otpPepper.toString("base64"),
		});
		process.stdout.write(
			[
				`AUTH_HASH_ACTIVE_VERSION=${version}`,
				`AUTH_HASH_KEYS_JSON=${hashRing}`,
				`AUTH_OTP_PEPPER_ACTIVE_VERSION=${version}`,
				`AUTH_OTP_PEPPER_KEYS_JSON=${otpRing}`,
				`AUTH_IDENTITY_DEDUP_KEY_VERSION=${version}`,
				"",
			].join("\n"),
		);
	} finally {
		hashKey.fill(0);
		otpPepper.fill(0);
	}
}

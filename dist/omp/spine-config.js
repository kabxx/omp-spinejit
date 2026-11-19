import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const OMP_SPINE_CONFIG_URL = new URL("../../spine.toml", import.meta.url);
/** Loads the packaged SpineConfig. Missing file is an error; there is no embedded fallback. */
export function loadOmpSpineConfigToml() {
    return readFileSync(fileURLToPath(OMP_SPINE_CONFIG_URL), "utf8");
}
//# sourceMappingURL=spine-config.js.map
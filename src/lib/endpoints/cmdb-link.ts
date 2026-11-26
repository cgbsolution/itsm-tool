/**
 * Links a device to its CMDB item after an inventory, through
 * `findOrCreateCiForDevice` from the CMDB module. A CMDB failure is logged
 * and never fails the inventory itself.
 */
import { exec, tx } from "@/lib/db"
import { log } from "@/lib/log"
import { findOrCreateCiForDevice } from "@/lib/cmdb/service"

export type CiDeviceInput = {
  hostname: string
  os_family: string
  os_name: string | null
  manufacturer: string | null
  model: string | null
  serial_no: string | null
  cpu: string | null
  ram_mb: number | null
  mac_addresses: string[]
  ip_addresses: string[]
}

/** Returns the CI id linked, or null when the CMDB step failed. */
export async function linkDeviceToCi(tenantId: string, deviceId: string, device: CiDeviceInput): Promise<string | null> {
  try {
    return await tx(async (db) => {
      const ciId = await findOrCreateCiForDevice(db, tenantId, device)
      if (!ciId) return null
      await exec("update devices set ci_id = $3 where id = $1 and tenant_id = $2 and ci_id is distinct from $3", [deviceId, tenantId, ciId], db)
      return ciId
    })
  } catch (err) {
    log.warn("agent.cmdb_link_failed", { device_id: deviceId, err })
    return null
  }
}

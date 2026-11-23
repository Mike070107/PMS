export type IntakeOperationKind = 'paid' | 'family';

/** Keep ambiguous submissions recoverable after refresh; never rotate the key in catch/finally. */
export function vehicleIntakeOperation(houseId: number | `shop:${number}`, kind: IntakeOperationKind, anotherVehicle = false) {
  const slot = `pms:vehicle-intake-operation:v1:${houseId}:${kind}:${anotherVehicle ? 'another' : 'continue'}`;
  let operationKey = sessionStorage.getItem(slot);
  if (!operationKey) {
    operationKey = crypto.randomUUID();
    sessionStorage.setItem(slot, operationKey);
  }
  return {
    operationKey,
    anotherVehicle,
    // Only a confirmed response resolves this operation. Subsequent explicit actions
    // get a new key, while server-side household reuse still finds the original draft.
    onFailure(error: unknown) {
      if ((error as {httpStatus?:number})?.httpStatus === 410 && sessionStorage.getItem(slot) === operationKey) sessionStorage.removeItem(slot);
    },
    resolve() {
      if (sessionStorage.getItem(slot) === operationKey) sessionStorage.removeItem(slot);
    },
  };
}

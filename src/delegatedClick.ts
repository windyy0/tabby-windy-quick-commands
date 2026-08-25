export function shouldHandleDelegatedAction (
    action: string,
    actionIsBackdrop: boolean,
    actionWasDirectTarget: boolean,
): boolean {
    return Boolean(action) && (!actionIsBackdrop || actionWasDirectTarget)
}

// A view is always in exactly one state.  Keep this separate from the UI so a
// failed request can never fall through and render stale/mock dashboard markup.
export const VIEW_STATE = Object.freeze({
  LOADING: 'LOADING',
  ERROR: 'ERROR',
  SUCCESS_EMPTY: 'SUCCESS_EMPTY',
  SUCCESS_DATA: 'SUCCESS_DATA',
})

export function getViewState({ loading = false, data = null, error = null } = {}, isEmpty = () => false) {
  if (error) return VIEW_STATE.ERROR
  if (loading) return VIEW_STATE.LOADING
  return isEmpty(data) ? VIEW_STATE.SUCCESS_EMPTY : VIEW_STATE.SUCCESS_DATA
}

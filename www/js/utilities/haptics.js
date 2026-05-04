const isNative = typeof window.Capacitor !== 'undefined';
const nativeHaptics = window.Capacitor?.Plugins?.Haptics || null;

export async function tapHaptic(){
  try {
    if(isNative && nativeHaptics?.selectionChanged){
      await nativeHaptics.selectionChanged();
      return;
    }
    if(navigator?.vibrate) navigator.vibrate(10);
  } catch(e) {}
}

export async function completeHaptic(){
  try {
    if(isNative && nativeHaptics?.impact){
      await nativeHaptics.impact({ style:'LIGHT' });
      return;
    }
    if(navigator?.vibrate) navigator.vibrate(20);
  } catch(e) {}
}
package com.rupnath.dayscore.reminders;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class DayScoreReminderRestoreReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        DayScoreReminderScheduler.restore(context);
    }
}
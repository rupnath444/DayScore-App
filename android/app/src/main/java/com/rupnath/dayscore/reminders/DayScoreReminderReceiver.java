package com.rupnath.dayscore.reminders;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class DayScoreReminderReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        DayScoreReminderScheduler.showNotification(context, intent);
    }
}
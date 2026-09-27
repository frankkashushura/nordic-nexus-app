package tz.co.nordictz.nexus;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.os.Build;

import android.app.Notification;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

/** Receives NEXUS push messages (chat, tenders, approvals, meetings, sign-ups) and shows them as phone notifications. */
public class PushService extends FirebaseMessagingService {
    static final String CHANNEL = "nexus_alerts";

    @Override
    public void onNewToken(String token) {
        MainActivity a = MainActivity.current;
        if (a != null) a.setToken(token);
    }

    @Override
    public void onMessageReceived(RemoteMessage msg) {
        Map<String, String> d = msg.getData();
        String title = d.get("title"), body = d.get("body"), open = d.get("open"), tag = d.get("tag");
        if (title == null && msg.getNotification() != null) { title = msg.getNotification().getTitle(); body = msg.getNotification().getBody(); }
        if (title == null) return;
        if (MainActivity.visible) return;   // NEXUS is open on screen: it already shows the message itself

        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "NEXUS messages and alerts", NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("Chat messages, new tenders, approvals, meetings and access requests");
            ch.enableLights(true); ch.setLightColor(Color.parseColor("#539FDC")); ch.enableVibration(true);
            ch.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),
                new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION).build());
            nm.createNotificationChannel(ch);
        }
        Intent i = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (open != null) i.putExtra("open", open);
        int req = (tag != null ? tag : title).hashCode();
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent pi = PendingIntent.getActivity(this, req, i, flags);

        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        b.setSmallIcon(R.drawable.ic_stat_nexus).setColor(Color.parseColor("#539FDC"))
         .setContentTitle(title).setContentText(body == null ? "" : body)
         .setStyle(new Notification.BigTextStyle().bigText(body == null ? "" : body))
         .setAutoCancel(true).setContentIntent(pi).setWhen(System.currentTimeMillis()).setShowWhen(true);
        if (Build.VERSION.SDK_INT < 26) b.setPriority(Notification.PRIORITY_HIGH).setDefaults(Notification.DEFAULT_ALL);
        if (open != null && open.startsWith("chat")) b.setCategory(Notification.CATEGORY_MESSAGE);
        try { nm.notify(tag != null ? tag : "nexus", 1, b.build()); } catch (SecurityException ignored) { /* notifications not allowed */ }
    }
}

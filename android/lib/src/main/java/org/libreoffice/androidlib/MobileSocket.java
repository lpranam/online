package org.libreoffice.androidlib;

import android.util.Log;
import android.webkit.WebResourceResponse;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.PipedInputStream;
import java.io.PipedOutputStream;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;

/**
 * Used to send messages to the webview from the native parts of the app
 *
 * This was previously done with loadUrl("javascript:window.TheFakeWebSocket.onmessage([...someData...])") but that was very slow
 *
 * This code connects to MobileSocket (a class based on ProxySocket which is used to workaround restrictive firewalls that do not
 * allow websocket use). MobileSocket is also used on iOS by the similarly-named MobileSocket Objective C interface
 *
 * Return messages are still sent via calling native methods from JS rather than by sending through the MobileSocket. That's because in
 * Android it is not possible to read the body of an intercepted request, which prevents you from implementing the other side of the
 * ProxySocket protocol. Similarly, long-running HTTP requests which continually receive partial data were ruled out as Android doesn't
 * reliably send partial responses immediately.
 */
public class MobileSocket {
    public interface Callback {
        void call();
    }

    int serial = 0;
    BlockingQueue<byte[]> sendingMessages;
    ExecutorService socketMessageExecutor;

    private static String LOGTAG = MobileSocket.class.getSimpleName();

    public MobileSocket() {
        sendingMessages = new LinkedBlockingQueue<>();
        socketMessageExecutor = Executors.newFixedThreadPool(1);
    }

    public void sendMessage(byte[] message, PipedOutputStream output) throws IOException {
        this.serial = this.serial + 1;

        byte[] serialString = Integer.toString(this.serial, 16).getBytes();
        byte[] sizeString = Integer.toString(message.length, 16).getBytes();

        ByteBuffer header = ByteBuffer.allocate(
                1 /* type */
                        + 2 /* hexadecimal preamble */
                        + serialString.length
                        + 1 /* hexadecimal end */
                        + 2 /* hexadecimal preamble */
                        + sizeString.length
                        + 1 /* hexadecimal end */
        );

        boolean binary = false;
        for (byte b : message) {
            if (b == '\n') {
                binary = true;
                break;
            }
        }

        header.put((byte) (binary ? 'B' : 'T'));

        // Preamble
        header.put((byte) '0');
        header.put((byte) 'x');

        header.put(serialString);
        header.put((byte) '\n'); // End of serial

        // Preamble
        header.put((byte) '0');
        header.put((byte) 'x');

        header.put(sizeString);
        header.put((byte) '\n'); // End of size

        output.write(header.array());
        output.write(message);
        output.write((byte) '\n'); // End of message
    }

    public void flushMessageBuffer(PipedOutputStream output) throws IOException {
        ArrayList<byte[]> messages = new ArrayList<>();
        sendingMessages.drainTo(messages);

        if (!messages.isEmpty()) {
            Log.d(LOGTAG, "Flushing " + messages.size() + " messages that were queued for MobileSocket sending");
        }

        for (byte[] message : messages) {
            sendMessage(message, output);
        }
        output.close();
    }

    public void queueSend(byte[] message, Callback callback) throws InterruptedException {
        sendingMessages.put(message);
        callback.call();
    }

    public WebResourceResponse open() {
        this.serial = 0;

        byte[] name = "mobile".getBytes();
        return COWebViewClient.response(
                200,
                "OK",
                new ByteArrayInputStream(name),
                name.length
        );
    }

    public WebResourceResponse write() {
        PipedInputStream data;
        try {
            PipedOutputStream output = new PipedOutputStream();
            data = new PipedInputStream(output);

            socketMessageExecutor.execute(() -> {
                try {
                    flushMessageBuffer(output);
                } catch (IOException e) {
                    throw new RuntimeException(e);
                }
            });
        } catch (IOException e) {
            throw new RuntimeException(e);
        }

        return COWebViewClient.response(200, "OK", data);
    }
}

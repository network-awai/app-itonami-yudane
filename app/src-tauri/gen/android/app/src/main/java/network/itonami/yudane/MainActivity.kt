package network.itonami.yudane

import android.content.res.Configuration
import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import kotlin.math.max

// System bars, display cutout and IME as padding of the content view, so the page never draws
// under the status or navigation bar (AWAI-3502; same approach as awai-os apps/yotei AWAI-3435).
class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    val content = findViewById<android.view.View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      view.setPadding(bars.left, bars.top, bars.right, max(bars.bottom, ime.bottom))
      insets
    }
    applySystemBarAppearance(resources.configuration)
    ViewCompat.requestApplyInsets(content)
  }

  // uiMode is in the manifest's configChanges, so a theme switch arrives here instead of recreating the activity.
  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    applySystemBarAppearance(newConfig)
  }

  // Decor colour = the page's --bg (src/ui/style.css): dark icons in light mode, light icons in dark mode.
  private fun applySystemBarAppearance(config: Configuration) {
    val light = (config.uiMode and Configuration.UI_MODE_NIGHT_MASK) != Configuration.UI_MODE_NIGHT_YES
    window.decorView.setBackgroundColor(if (light) 0xFFF7F7F5.toInt() else 0xFF161615.toInt())
    if (android.os.Build.VERSION.SDK_INT >= 29) window.isNavigationBarContrastEnforced = false
    WindowInsetsControllerCompat(window, findViewById(android.R.id.content)).apply {
      isAppearanceLightStatusBars = light
      isAppearanceLightNavigationBars = light
    }
  }
}

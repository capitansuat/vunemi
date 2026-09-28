// Language menu, scroll reveal, and the hero demo that plays once when it comes into view.
(function () {
  var picker = document.getElementById("language");
  if (picker) picker.addEventListener("change", function () {
    try { localStorage.setItem("vunemi.lang", picker.value); } catch (e) {}
    location.href = "/" + picker.value + "/" + (picker.dataset.page || "");
  });

  var form = document.getElementById("support-form");
  if (form) form.addEventListener("submit", async function (event) {
    event.preventDefault();
    var button = form.querySelector('button[type="submit"]');
    var status = document.getElementById("support-status");
    var original = button.textContent;
    button.disabled = true;
    button.textContent = form.dataset.sending;
    status.textContent = "";
    try {
      var response = await fetch(form.action, {
        method: "POST",
        body: new URLSearchParams(new FormData(form)),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      var result = await response.json();
      status.textContent = result.ok ? form.dataset.success : response.status === 429 ? form.dataset.rate : result.code === "verification_failed" ? form.dataset.verify : form.dataset.failure;
      if (result.ok) form.reset();
    } catch (error) {
      status.textContent = form.dataset.failure;
    } finally {
      button.disabled = false;
      button.textContent = original;
      if (window.turnstile) window.turnstile.reset();
    }
  });

  var targets = document.querySelectorAll(".reveal, .demo");
  if (!("IntersectionObserver" in window)) {
    targets.forEach(function (el) { el.classList.add("in", "play"); });
    return;
  }
  var seen = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      entry.target.classList.add(entry.target.classList.contains("demo") ? "play" : "in");
      seen.unobserve(entry.target);
    });
  }, { threshold: 0.15 });
  targets.forEach(function (el) { seen.observe(el); });
})();

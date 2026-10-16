
$(function() {

    // Fork-Erweiterung: toggle: false, damit das Aufklappen einer Gruppe die andere nicht zuklappt
    $('#side-menu').metisMenu({ toggle: false });

    // Fork-Erweiterung: Die Gruppen "LED Instanzen" und "System" klappen nur per Klick auf ihren
    // eigenen Titel auf und zu und merken sich den Zustand. Navigation und SwitchToMenuItem klappen
    // sie sonst ungefragt zu; solche Änderungen werden auf den gespeicherten Zustand zurückgesetzt.
    var keepGroupState = function (linkId, key, defaultOpen) {
        var link = document.getElementById(linkId);
        var list = link && link.nextElementSibling;
        if (!list) return;
        var userUntil = 0;
        var stored = function () {
            try {
                var v = localStorage.getItem(key);
                return v === null ? defaultOpen : v !== 'closed';
            } catch (e) { return defaultOpen; }
        };
        var show = function (open) {
            list.classList.toggle('mm-show', open);
            link.parentElement.classList.toggle('mm-active', open);
            list.style.height = '';
        };
        show(stored());
        // Capture-Phase: läuft vor dem Klick-Handler von metisMenu
        link.addEventListener('click', function () { userUntil = Date.now() + 1500; }, true);
        new MutationObserver(function () {
            if (list.classList.contains('mm-collapsing')) return;
            var shown = list.classList.contains('mm-show');
            if (Date.now() < userUntil) {
                try { localStorage.setItem(key, shown ? 'open' : 'closed'); } catch (e) { }
            } else if (shown !== stored()) {
                show(stored());
            }
        }).observe(list, { attributes: true, attributeFilter: ['class'] });
    };
    keepGroupState('MenuItemLedInstances', 'ledInstancesMenuOpen', true);
    keepGroupState('MenuItemSystem', 'systemMenuOpen', false);

});

var mInit = false;
// Fork-Erweiterung: dieselbe Grenze wie das CSS (min-width: 768px). innerWidth ist ganzzahlig gerundet und
// lag bei Zoom oder Windows-Skalierung (z. B. 767,2 px) auf der falschen Seite
var wideLayout = window.matchMedia("(min-width: 768px)");

//Loads the correct sidebar on window load,
//collapses the sidebar on window resize.
// Sets the min-height of #page-wrapper to window size
$(function() {
    $(window).on("load resize", function() {
        var topOffset = 50;
		// Fork-Erweiterung: im schmalen Fenster ist das Seitenmenü eine Schublade von links unter der
		// festen Kopfzeile (Lage und Größe in css/hyperion.css); hier nur das Zurücksetzen beim Umschalten
		if (!wideLayout.matches)
		{
			if(!mInit)
			{
				mInit = true;
				$('#main-nav').removeAttr('style');
				$(".navbar-toggle").addClass("closed");
			}
			topOffset = 56;
		}
		else
		{
			$( "#main-nav" ).removeAttr('style');
			mInit = false;
		}

		var height = ((this.window.innerHeight > 0) ? this.window.innerHeight : this.screen.height) - 1;
		height = height - topOffset;
		if (height < 1) height = 1;
		if (height > topOffset) {
			$("#page-wrapper").css("min-height", (height-11) + "px");
		}
    });

    var url = window.location;
    // var element = $('ul.nav a').filter(function() {
    //     return this.href == url;
    // }).addClass('active').parent().parent().addClass('in').parent();
    var element = $('ul.nav a').filter(function() {
     return this.href == url;
    }).addClass('active').parent();

    while(true){
        if (element.is('li')){
            element = element.parent().addClass('in').parent();
        } else {
            break;
        }
    }
});

// Fork-Erweiterung: Menüknopf links neben dem Logo öffnet und schließt die Schublade; ein Menüpunkt
// schließt sie wieder (früher nur gebunden, wenn die Initialisierung beim Laden griff)
var navDrawer = function (open) {
	$('#main-nav').stop().animate({ left: open ? "0px" : "-235px" }, 300);
	$(".navbar-toggle").toggleClass("closed", !open);
};
// Fork-Erweiterung: im breiten Fenster blendet der Menüknopf die Seitenleiste aus und ein (gespeichert)
var setSideCollapsed = function (collapsed) {
	document.documentElement.classList.toggle("side-collapsed", collapsed);
	try { localStorage.setItem("sideCollapsed", collapsed ? "1" : "0"); } catch (e) { }
};
try { document.documentElement.classList.toggle("side-collapsed", localStorage.getItem("sideCollapsed") === "1"); } catch (e) { }
$('.navbar-toggle').on('click', function(){
	if (wideLayout.matches) {
		setSideCollapsed(!document.documentElement.classList.contains("side-collapsed"));
		return;
	}
	navDrawer($(".navbar-toggle").hasClass("closed"));
});
$(document).on('click', '.mnava', function(){
	if (!wideLayout.matches) navDrawer(false);
});

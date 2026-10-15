
$(function() {

    // Fork-Erweiterung: toggle: false, damit das Aufklappen einer Gruppe die andere nicht zuklappt
    $('#side-menu').metisMenu({ toggle: false });

    // Fork-Erweiterung: "LED Instanzen" klappt nur per Klick auf den eigenen Titel auf und zu und
    // merkt sich den Zustand. Navigation und SwitchToMenuItem klappen die Gruppe sonst ungefragt
    // zu; solche Änderungen werden auf den gespeicherten Zustand zurückgesetzt.
    var link = document.getElementById('MenuItemLedInstances');
    var list = link && link.nextElementSibling;
    if (list) {
        var KEY = 'ledInstancesMenuOpen';
        var userUntil = 0;
        var stored = function () {
            try { return localStorage.getItem(KEY) !== 'closed'; } catch (e) { return true; }
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
                try { localStorage.setItem(KEY, shown ? 'open' : 'closed'); } catch (e) { }
            } else if (shown !== stored()) {
                show(stored());
            }
        }).observe(list, { attributes: true, attributeFilter: ['class'] });
    }

});

var mInit = false;

//Loads the correct sidebar on window load,
//collapses the sidebar on window resize.
// Sets the min-height of #page-wrapper to window size
$(function() {
    $(window).on("load resize", function() {
        var topOffset = 50;
        var width = (this.window.innerWidth > 0) ? this.window.innerWidth : this.screen.width;
		if (width < 768)
		{
			if(!mInit)
			{
				mInit = true;
				$('#main-nav').css({"position":"fixed","right":"-235px","top":"45px","width":"230px","border":"1px solid rgba(0, 0, 0, .2)","box-shadow":"0 3px 9px rgba(0, 0, 0, .5)"});
				topOffset = 100; // 2-row-menu
				
				$('.mnava').bind('click.smnav', function(){
					$( "#main-nav" ).animate({right: "-235px",}, 300 );
					$(".navbar-toggle").addClass("closed");
				});
			}
		}
		else
		{
			$( "#main-nav" ).removeAttr('style').css({"position":"fixed"});
			$( ".mnava" ).off('click.smnav');
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

$('.navbar-toggle').on('click', function(){
	if($('#main-nav').css("right") != "-2px")
	{
		 $('#main-nav').animate({right: "-2px",}, 300 );
		 $(".navbar-toggle").removeClass("closed");
	}
	else
	{
		$('#main-nav').animate({right: "-235px",}, 300 );
		$(".navbar-toggle").addClass("closed");
	}
});
